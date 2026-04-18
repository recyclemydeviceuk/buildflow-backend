import mongoose from 'mongoose'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { Settings } from '../models/Settings'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'

/**
 * Auto-assign an UNOWNED lead based on the current routing configuration.
 *
 * Policy:
 * 1. If the lead already has an owner → no-op (we never override manual/webhook assignments).
 * 2. If `Settings.leadRouting.mode` is not `'auto'` → no-op (manual mode is the default).
 * 3. City-specific rules win first: if the lead's city appears in any rule, that rule's rep
 *    is the owner.
 * 4. Otherwise we pick the active representative with the oldest `lastAssignedLeadAt`
 *    (fair rotation that survives reps going on/off shift).
 *
 * Failures are swallowed so lead creation itself is never rejected because of routing.
 * Fire-and-forget this from any lead-entry point.
 */
export const routeLead = async (leadId: string | mongoose.Types.ObjectId): Promise<{ id: string; name: string } | null> => {
  try {
    const lead = await Lead.findById(leadId)
    if (!lead) return null
    if (lead.owner) return null // never override an existing assignment

    const settings = await Settings.findOne({}, 'leadRouting').lean()
    if (!settings?.leadRouting || settings.leadRouting.mode !== 'auto') {
      return null
    }

    const rules = settings.leadRouting.cityAssignmentRules || []
    const leadCity = (lead.city || '').trim()
    const leadCityLower = leadCity.toLowerCase()

    // 1) City-rule check — first matching rule wins.
    // A rule can list one or many reps. If multiple, we round-robin WITHIN the
    // rule by picking whichever of those reps has waited longest.
    let chosenRep: { _id: mongoose.Types.ObjectId; name: string } | null = null
    if (leadCity) {
      for (const rule of rules) {
        const ruleCities = (rule.cities || []).map((c: string) => String(c).trim().toLowerCase())
        if (!ruleCities.includes(leadCityLower)) continue

        // Support both new multi-rep shape and legacy single-rep shape.
        const ruleUserIds: any[] = Array.isArray((rule as any).userIds) && (rule as any).userIds.length
          ? (rule as any).userIds
          : (rule as any).userId
          ? [(rule as any).userId]
          : []
        if (ruleUserIds.length === 0) continue

        const candidate = await User.findOne({
          _id: { $in: ruleUserIds },
          role: 'representative',
          isActive: true,
        })
          .sort({ lastAssignedLeadAt: 1, createdAt: 1 })
          .select('_id name')
          .lean()

        if (candidate) {
          chosenRep = { _id: candidate._id as mongoose.Types.ObjectId, name: candidate.name }
          logger.info('Lead routed via city rule', {
            leadId: String(lead._id),
            city: leadCity,
            poolSize: ruleUserIds.length,
            repId: String(candidate._id),
            repName: candidate.name,
          })
          break
        }
      }
    }

    // 2) Fallback — round-robin across all active reps by oldest lastAssignedLeadAt
    if (!chosenRep) {
      const rep = await User.findOne({
        role: 'representative',
        isActive: true,
      })
        .sort({ lastAssignedLeadAt: 1, createdAt: 1 })
        .select('_id name')
        .lean()
      if (!rep) {
        logger.warn('Round-robin routing found no active representative', { leadId: String(lead._id) })
        return null
      }
      chosenRep = { _id: rep._id as mongoose.Types.ObjectId, name: rep.name }
      logger.info('Lead routed via round-robin', {
        leadId: String(lead._id),
        repId: String(rep._id),
        repName: rep.name,
      })
    }

    const now = new Date()
    await Promise.all([
      Lead.findByIdAndUpdate(lead._id, {
        $set: {
          owner: chosenRep._id,
          ownerName: chosenRep.name,
          assignedAt: now,
          assignmentAcknowledged: false, // triggers the rep's "New Lead Assigned" popup
        },
      }),
      User.findByIdAndUpdate(chosenRep._id, { $set: { lastAssignedLeadAt: now } }),
    ])

    // Notify the frontend so the sticky popup appears for the chosen rep
    emitToTeam('all', 'lead:assigned', {
      leadId: String(lead._id),
      leadName: lead.name,
      assignedTo: String(chosenRep._id),
      assignedToName: chosenRep.name,
    })

    return { id: String(chosenRep._id), name: chosenRep.name }
  } catch (err) {
    logger.error('routeLead failed (non-fatal, lead left unassigned)', err)
    return null
  }
}

// Legacy exports kept for the queue-service call sites. They still don't do anything —
// BuildFlow's round-robin doesn't use the offer/accept queue system.
export const getNextRep = async (): Promise<{ id: string; name: string } | null> => null
export const autoRouteQueueItem = async (_queueItemId: string): Promise<boolean> => false
