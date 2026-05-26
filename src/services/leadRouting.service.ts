import mongoose from 'mongoose'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { Settings } from '../models/Settings'
import { logger } from '../utils/logger'
import { notifyLeadAssigned } from './socket.service'

/**
 * Auto-assign an UNOWNED lead based on the current routing configuration.
 *
 * Policy:
 * 1. If the lead already has an owner → no-op (we never override manual/webhook assignments).
 * 2. If `Settings.leadRouting.mode` is not `'auto'` → no-op (manual mode is the default).
 * 3. City-specific rules win first: if the lead's city appears in any rule, that rule's rep
 *    is the owner. City comparison is alias-aware (Bangalore ↔ Bengaluru,
 *    Mysore ↔ Mysuru, etc.) and case/space tolerant.
 * 4. Otherwise we pick the active representative with the oldest `lastAssignedLeadAt`
 *    from the UNSCOPED pool — i.e. reps NOT listed in any city rule. A rep
 *    bound to "Mysore" never gets a Bangalore lead, even when their
 *    rotation comes up.
 * 5. If no eligible rep exists, the lead stays unassigned. A manager can
 *    pick it up from the Unassigned pool.
 *
 * Failures are swallowed so lead creation itself is never rejected because of routing.
 * Fire-and-forget this from any lead-entry point.
 */

// Common Indian city aliases so a Meta lead form saying "Bengaluru" still
// matches a rule the manager wrote as "Bangalore" (and vice versa). All
// lookups are done in lower-case after trimming.
const CITY_ALIASES: Record<string, string[]> = {
  bangalore: ['bengaluru'],
  bengaluru: ['bangalore'],
  mysore: ['mysuru'],
  mysuru: ['mysore'],
  mumbai: ['bombay'],
  bombay: ['mumbai'],
  chennai: ['madras'],
  madras: ['chennai'],
  kolkata: ['calcutta'],
  calcutta: ['kolkata'],
  pune: ['poona'],
  poona: ['pune'],
  kochi: ['cochin'],
  cochin: ['kochi'],
  thiruvananthapuram: ['trivandrum'],
  trivandrum: ['thiruvananthapuram'],
}

const normalizeCity = (raw: string): string => String(raw || '').trim().toLowerCase()

const citiesMatch = (a: string, b: string): boolean => {
  const na = normalizeCity(a)
  const nb = normalizeCity(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if ((CITY_ALIASES[na] || []).includes(nb)) return true
  if ((CITY_ALIASES[nb] || []).includes(na)) return true
  return false
}

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

    // Collect the set of rep IDs that are bound to ANY city rule. These reps
    // are "city-scoped" — they only ever receive leads for their listed
    // cities. They are explicitly excluded from the unscoped round-robin
    // pool below, which is what stops a Mysore-scoped rep from being handed
    // a Bangalore lead just because their rotation came up.
    const scopedRepIds = new Set<string>()
    for (const rule of rules) {
      const ruleUserIds: any[] = Array.isArray((rule as any).userIds) && (rule as any).userIds.length
        ? (rule as any).userIds
        : (rule as any).userId
        ? [(rule as any).userId]
        : []
      for (const u of ruleUserIds) {
        if (u) scopedRepIds.add(String(u))
      }
    }

    let chosenRep: { _id: mongoose.Types.ObjectId; name: string } | null = null

    // 1) City-rule check — first matching rule wins. Comparison is alias-
    // aware so "Bangalore" rules apply to "Bengaluru" leads (and the other
    // direction too).
    if (leadCity) {
      for (const rule of rules) {
        const ruleCities = rule.cities || []
        const matched = ruleCities.some((c: string) => citiesMatch(c, leadCity))
        if (!matched) continue

        const ruleUserIds: any[] = Array.isArray((rule as any).userIds) && (rule as any).userIds.length
          ? (rule as any).userIds
          : (rule as any).userId
          ? [(rule as any).userId]
          : []
        if (ruleUserIds.length === 0) continue

        // Within the rule, rotate fairly — oldest assignment wins.
        const candidate = await User.findOne({
          _id: { $in: ruleUserIds },
          role: 'representative',
          isActive: true,
          // Skip reps the manager has blocked from receiving leads. `$ne: false`
          // matches both `true` and missing field, so legacy users keep working.
          canReceiveLeads: { $ne: false },
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
        } else {
          // The rule matched but every rep in it is inactive / unavailable.
          // Log it loudly — silently falling through to the global pool was
          // the original cause of city-scoped misroutes (Bangalore leads
          // landing on Mysore reps). We DO continue checking later rules,
          // but we'll NOT use a city-scoped rep as a fallback.
          logger.warn('City rule matched but no rep available', {
            leadId: String(lead._id),
            city: leadCity,
            poolSize: ruleUserIds.length,
          })
        }
      }
    }

    // 2) Fallback — round-robin across UNSCOPED active reps only. A rep
    // listed in any city rule is excluded here so a Mysore-scoped rep never
    // catches a Bangalore lead via rotation. If no unscoped rep exists, the
    // lead stays unassigned and a manager can route it manually.
    if (!chosenRep) {
      const rep = await User.findOne({
        role: 'representative',
        isActive: true,
        canReceiveLeads: { $ne: false },
        _id: scopedRepIds.size > 0
          ? { $nin: Array.from(scopedRepIds).map((id) => new mongoose.Types.ObjectId(id)) }
          : { $exists: true },
      })
        .sort({ lastAssignedLeadAt: 1, createdAt: 1 })
        .select('_id name')
        .lean()
      if (!rep) {
        logger.warn('Round-robin routing found no eligible UNSCOPED representative', {
          leadId: String(lead._id),
          city: leadCity,
          scopedRepCount: scopedRepIds.size,
        })
        return null
      }
      chosenRep = { _id: rep._id as mongoose.Types.ObjectId, name: rep.name }
      logger.info('Lead routed via round-robin (unscoped pool)', {
        leadId: String(lead._id),
        city: leadCity,
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

    // Unified fan-out (team broadcast + per-user nudge). Same helper every
    // assignment path uses, so the receiving rep's LeadList re-fetches
    // instantly and the assignment popup pops in Layout.
    notifyLeadAssigned(String(lead._id), String(chosenRep._id), chosenRep.name, {
      leadName: lead.name,
      phone: lead.phone,
      city: lead.city,
      source: lead.source,
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

/**
 * Single source of truth for "can this rep be given a new lead right now?".
 *
 * A rep is eligible iff:
 *   • the account exists, role = representative
 *   • `isActive: true` (account not deactivated by a manager)
 *   • `canReceiveLeads !== false` (lead-receiving switch is on)
 *
 * Used by EVERY assignment entry-point (manual assign, bulk assign, queue
 * assign, queue-offer accept, import resolution). Centralising the check
 * means the rule "no leads to off accounts" can never be silently broken
 * by a new code path that forgets one of the two flags.
 */
export const findEligibleRep = async (
  userId: string | mongoose.Types.ObjectId
): Promise<{ _id: mongoose.Types.ObjectId; name: string; email: string; notificationPrefs?: any } | null> => {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) return null
  const rep = await User.findOne({
    _id: userId,
    role: 'representative',
    isActive: true,
    canReceiveLeads: { $ne: false },
  }).select('_id name email notificationPrefs').lean()
  return rep as any
}

/** Boolean variant for paths that already have the user — saves a roundtrip. */
export const isRepEligible = async (
  userId: string | mongoose.Types.ObjectId
): Promise<boolean> => Boolean(await findEligibleRep(userId))
