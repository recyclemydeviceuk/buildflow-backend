/**
 * Timy AI tool registry.
 *
 * Each tool has two parts:
 *  - `declaration`: the JSON-schema-ish blob we pass to Gemini Live so the
 *    model knows what it can call.
 *  - `handler`:     the server-side function that actually queries / mutates
 *    MongoDB when Gemini decides to invoke the tool.
 *
 * Permissions:
 *  - Representatives only ever see / mutate their own leads. Manager-only
 *    tools are flagged with `managerOnly: true`.
 *  - Demo accounts (`ctx.isDemo`) cannot run any `mutating: true` tool —
 *    same gate the REST middleware enforces, just translated for the model.
 *  - We never trust the model to gate access. All checks happen server-side.
 */
import mongoose from 'mongoose'
import { Lead } from '../../models/Lead'
import { User } from '../../models/User'
import { FollowUp } from '../../models/FollowUp'
import { Call } from '../../models/Call'
import { emitToTeam } from '../../config/socket'
import { logger } from '../../utils/logger'
import { DISPOSITIONS } from '../../config/constants'

export interface TimyContext {
  userId: string
  userName: string
  userRole: 'manager' | 'representative'
  isDemo: boolean
  /** Voice + reply language. Defaults to Indian English. */
  language: 'en-IN' | 'hi-IN' | 'kn-IN'
  /**
   * Recent conversation turns, passed in on reconnect (e.g. language switch)
   * so the new session continues instead of starting over. Capped server-side.
   */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
}

export interface TimyToolDeclaration {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

type Handler = (args: any, ctx: TimyContext) => Promise<any>

interface Tool {
  declaration: TimyToolDeclaration
  managerOnly?: boolean
  /** Write tool — refused for demo accounts. */
  mutating?: boolean
  handler: Handler
}

// ── Helpers ────────────────────────────────────────────────────────────────
const ownerScope = (ctx: TimyContext, leadFilter: any = {}) => {
  if (ctx.userRole === 'representative') {
    return { ...leadFilter, owner: new mongoose.Types.ObjectId(ctx.userId) }
  }
  return leadFilter
}

const startOfDay = (d = new Date()) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const endOfDay = (d = new Date()) => {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

const isValidObjectId = (id: any): boolean => {
  if (typeof id !== 'string' || !id) return false
  return mongoose.Types.ObjectId.isValid(id)
}

/**
 * Returns the lead document if the caller can mutate it (manager always,
 * rep only if they own it). Returns null + a structured error otherwise.
 */
const loadMutableLead = async (
  leadId: string,
  ctx: TimyContext
): Promise<
  { lead: any; error?: undefined } | { error: string; lead?: undefined }
> => {
  if (!isValidObjectId(leadId)) {
    return { error: 'Invalid leadId. Use find_lead first to get an id.' }
  }
  const lead = await Lead.findById(leadId)
  if (!lead) return { error: 'Lead not found.' }
  if (ctx.userRole === 'representative') {
    const ownerId = lead.owner ? String(lead.owner) : null
    if (!ownerId || ownerId !== ctx.userId) {
      return { error: "You don't own this lead, so you can't change it." }
    }
  }
  return { lead }
}

const recomputeNextFollowUp = async (leadId: mongoose.Types.ObjectId) => {
  const earliest = await FollowUp.findOne({ lead: leadId, status: 'pending' })
    .sort({ scheduledAt: 1 })
    .select('scheduledAt')
    .lean()
  await Lead.findByIdAndUpdate(leadId, {
    $set: { nextFollowUp: earliest ? earliest.scheduledAt : null },
  })
}

// ── Tools ──────────────────────────────────────────────────────────────────
const tools: Record<string, Tool> = {
  // ───── Session management ─────────────────────────────────────────────
  switch_language: {
    declaration: {
      name: 'switch_language',
      description:
        "Switch the voice and reply language for this session. Call this WHENEVER the user asks to change language — e.g. 'switch to Hindi', 'speak English', 'ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ', 'हिन्दी में बात करो'. The relay will reconnect with the new voice automatically and the conversation will continue. Always call this tool first; never just start replying in the new language without calling it, because the voice won't change until the reconnect happens.",
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['en-IN', 'hi-IN', 'kn-IN'],
            description:
              'Target language code: en-IN (Indian English, female), hi-IN (Hindi, male), kn-IN (Kannada, female).',
          },
        },
        required: ['language'],
      },
    },
    handler: async (args) => {
      const raw = args?.language
      const target: 'en-IN' | 'hi-IN' | 'kn-IN' =
        raw === 'hi-IN' ? 'hi-IN' : raw === 'kn-IN' ? 'kn-IN' : 'en-IN'
      return {
        switched: true,
        language: target,
        note: 'Session will reconnect with the new voice in a moment.',
      }
    },
  },

  // ───── Read: leads ────────────────────────────────────────────────────
  find_lead: {
    declaration: {
      name: 'find_lead',
      description:
        'Search leads by name fragment or phone number. Returns up to 5 matches with their leadId (use this id for any other tool that mutates the lead), disposition, owner, follow-up, and last activity.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name fragment or phone digits' },
        },
        required: ['query'],
      },
    },
    handler: async (args, ctx) => {
      const q = String(args?.query || '').trim()
      if (!q) return { error: 'Empty query' }
      const phoneDigits = q.replace(/[^\d]/g, '')
      const or: any[] = [{ name: { $regex: q, $options: 'i' } }]
      if (phoneDigits.length >= 4) or.push({ phone: { $regex: phoneDigits } })
      const filter = ownerScope(ctx, { $or: or })
      const leads = await Lead.find(filter)
        .limit(5)
        .select('name phone city disposition source ownerName owner nextFollowUp updatedAt notes')
        .lean()
      return {
        count: leads.length,
        leads: leads.map((l) => ({
          leadId: String(l._id),
          name: l.name,
          phone: l.phone,
          city: l.city,
          disposition: l.disposition,
          source: l.source,
          ownerId: l.owner ? String(l.owner) : null,
          owner: l.ownerName,
          nextFollowUp: l.nextFollowUp,
          notes: l.notes,
          lastUpdate: l.updatedAt,
        })),
      }
    },
  },

  list_recent_leads: {
    declaration: {
      name: 'list_recent_leads',
      description:
        'List the most recently created leads. Use this when the user asks "what leads came in today" or "show me the latest leads".',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max leads to return (1-15)', minimum: 1, maximum: 15 },
          days: { type: 'integer', description: 'Look back this many days (default 7)', minimum: 1, maximum: 90 },
          disposition: { type: 'string', description: 'Optional disposition filter (e.g. "New")' },
        },
      },
    },
    handler: async (args, ctx) => {
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 15)
      const days = Math.min(Math.max(Number(args?.days) || 7, 1), 90)
      const since = new Date(Date.now() - days * 86400 * 1000)
      const filter: any = { createdAt: { $gte: since } }
      if (args?.disposition) filter.disposition = String(args.disposition)
      const leads = await Lead.find(ownerScope(ctx, filter))
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('name phone city disposition ownerName createdAt')
        .lean()
      return {
        count: leads.length,
        leads: leads.map((l) => ({ leadId: String(l._id), ...l, _id: undefined })),
      }
    },
  },

  count_leads_by_disposition: {
    declaration: {
      name: 'count_leads_by_disposition',
      description:
        'Count leads grouped by disposition (e.g. New, Contacted/Open, Visit Done, Booking Done). Use this for pipeline overview questions.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Look-back window in days (default = all time)', minimum: 1, maximum: 365 },
        },
      },
    },
    handler: async (args, ctx) => {
      const match: any = {}
      if (args?.days) {
        const since = new Date(Date.now() - Number(args.days) * 86400 * 1000)
        match.createdAt = { $gte: since }
      }
      const scoped = ownerScope(ctx, match)
      const rows = await Lead.aggregate([
        { $match: scoped },
        { $group: { _id: '$disposition', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      return {
        total: rows.reduce((a, r) => a + r.count, 0),
        byDisposition: rows.map((r) => ({ disposition: r._id, count: r.count })),
      }
    },
  },

  // ───── Read: follow-ups ───────────────────────────────────────────────
  get_today_followups: {
    declaration: {
      name: 'get_today_followups',
      description:
        "Return today's pending follow-ups for the current user (or for the whole team if the user is a manager). Each row carries a followUpId you can pass to complete_followup / cancel_followup.",
      parameters: { type: 'object', properties: {} },
    },
    handler: async (_args, ctx) => {
      const filter: any = {
        status: 'pending',
        scheduledAt: { $gte: startOfDay(), $lte: endOfDay() },
      }
      if (ctx.userRole === 'representative') filter.owner = new mongoose.Types.ObjectId(ctx.userId)
      const list = await FollowUp.find(filter)
        .sort({ scheduledAt: 1 })
        .limit(20)
        .select('leadName lead ownerName scheduledAt notes')
        .lean()
      return {
        count: list.length,
        followUps: list.map((f) => ({
          followUpId: String(f._id),
          leadId: String(f.lead),
          leadName: f.leadName,
          owner: f.ownerName,
          scheduledAt: f.scheduledAt,
          notes: f.notes,
        })),
      }
    },
  },

  get_overdue_followups: {
    declaration: {
      name: 'get_overdue_followups',
      description:
        'Return overdue (a.k.a. ignored) pending follow-ups whose scheduled time has passed. Each row carries a followUpId.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 25 },
        },
      },
    },
    handler: async (args, ctx) => {
      const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 25)
      const filter: any = { status: 'pending', scheduledAt: { $lt: new Date() } }
      if (ctx.userRole === 'representative') filter.owner = new mongoose.Types.ObjectId(ctx.userId)
      const list = await FollowUp.find(filter)
        .sort({ scheduledAt: 1 })
        .limit(limit)
        .select('leadName lead ownerName scheduledAt notes')
        .lean()
      return {
        count: list.length,
        overdue: list.map((f) => ({
          followUpId: String(f._id),
          leadId: String(f.lead),
          leadName: f.leadName,
          owner: f.ownerName,
          scheduledAt: f.scheduledAt,
          notes: f.notes,
        })),
      }
    },
  },

  // ───── Read: calls / pipeline / team ──────────────────────────────────
  get_my_recent_calls: {
    declaration: {
      name: 'get_my_recent_calls',
      description: "Return the user's most recent calls (incoming + outbound). Reps see their own; managers see the team.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 15 },
          status: {
            type: 'string',
            description: 'Optional status filter, e.g. "completed", "no-answer", "missed".',
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 15)
      const filter: any = {}
      if (ctx.userRole === 'representative') filter.representative = new mongoose.Types.ObjectId(ctx.userId)
      if (args?.status) filter.status = String(args.status)
      const calls = await Call.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('leadName phone direction status outcome duration startedAt representativeName')
        .lean()
      return { count: calls.length, calls }
    },
  },

  get_team_overview: {
    declaration: {
      name: 'get_team_overview',
      description:
        'Manager-only. Returns each active representative with userId, availability, whether they accept new leads, and how many leads they currently own.',
      parameters: { type: 'object', properties: {} },
    },
    managerOnly: true,
    handler: async () => {
      const reps = await User.find({ role: 'representative', isActive: true })
        .select('name email phone callAvailabilityStatus canReceiveLeads lastAssignedLeadAt')
        .lean()
      const counts = await Lead.aggregate([
        { $match: { owner: { $in: reps.map((r) => r._id) } } },
        { $group: { _id: '$owner', count: { $sum: 1 } } },
      ])
      const countMap = new Map(counts.map((r) => [String(r._id), r.count]))
      return {
        reps: reps.map((r) => ({
          userId: String(r._id),
          name: r.name,
          email: r.email,
          availability: r.callAvailabilityStatus,
          acceptingNewLeads: r.canReceiveLeads !== false,
          ownedLeads: countMap.get(String(r._id)) || 0,
          lastAssignedAt: (r as any).lastAssignedLeadAt,
        })),
      }
    },
  },

  find_team_member: {
    declaration: {
      name: 'find_team_member',
      description:
        'Manager-only. Look up a team member by name fragment (case-insensitive). Returns up to 5 matches with userId, role, and availability — useful before calling assign_lead or set_rep_lead_receiving.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name fragment to search for' },
        },
        required: ['query'],
      },
    },
    managerOnly: true,
    handler: async (args) => {
      const q = String(args?.query || '').trim()
      if (!q) return { error: 'Empty query' }
      const list = await User.find({
        name: { $regex: q, $options: 'i' },
        isActive: true,
      })
        .limit(5)
        .select('name email role callAvailabilityStatus canReceiveLeads')
        .lean()
      return {
        count: list.length,
        members: list.map((m) => ({
          userId: String(m._id),
          name: m.name,
          email: m.email,
          role: m.role,
          availability: m.callAvailabilityStatus,
          acceptingNewLeads: m.canReceiveLeads !== false,
        })),
      }
    },
  },

  get_my_pipeline_summary: {
    declaration: {
      name: 'get_my_pipeline_summary',
      description:
        'Quick personal scoreboard: leads owned, pending follow-ups today, overdue follow-ups, calls made in the last 7 days.',
      parameters: { type: 'object', properties: {} },
    },
    handler: async (_args, ctx) => {
      const ownerObjId =
        ctx.userRole === 'representative' ? new mongoose.Types.ObjectId(ctx.userId) : null
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000)
      const [leadsOwned, todayFollowUps, overdueFollowUps, callsLast7d] = await Promise.all([
        Lead.countDocuments(ownerObjId ? { owner: ownerObjId } : {}),
        FollowUp.countDocuments({
          status: 'pending',
          scheduledAt: { $gte: startOfDay(), $lte: endOfDay() },
          ...(ownerObjId ? { owner: ownerObjId } : {}),
        }),
        FollowUp.countDocuments({
          status: 'pending',
          scheduledAt: { $lt: new Date() },
          ...(ownerObjId ? { owner: ownerObjId } : {}),
        }),
        Call.countDocuments({
          createdAt: { $gte: sevenDaysAgo },
          ...(ownerObjId ? { representative: ownerObjId } : {}),
        }),
      ])
      return {
        scope: ctx.userRole === 'manager' ? 'team' : 'personal',
        leadsOwned,
        followUpsDueToday: todayFollowUps,
        overdueFollowUps,
        callsLast7Days: callsLast7d,
      }
    },
  },

  // ───── WRITE: leads ───────────────────────────────────────────────────
  create_lead: {
    declaration: {
      name: 'create_lead',
      description:
        "Create a new lead. Owner is set to the current user automatically. Disposition defaults to 'New'. Confirm the parsed name + phone back to the user before calling — voice transcription can mishear digits.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lead name' },
          phone: { type: 'string', description: '10-digit Indian phone number; +91/0 prefixes are stripped' },
          city: { type: 'string', description: 'Lead city (default "Bangalore" if omitted)' },
          source: {
            type: 'string',
            description: 'Source channel — Direct, Manual, Meta, Website, Google ADS. Defaults to Manual.',
          },
          disposition: {
            type: 'string',
            description: 'Initial disposition. Must be one of the supported names; defaults to "New".',
          },
          notes: { type: 'string', description: 'Free-form notes' },
        },
        required: ['name', 'phone'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      const name = String(args?.name || '').trim()
      const rawPhone = String(args?.phone || '').replace(/\D/g, '')
      if (!name) return { error: 'Lead name is required.' }
      if (rawPhone.length < 10) return { error: 'Phone must be at least 10 digits.' }
      const phone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone

      const disposition = DISPOSITIONS.includes(args?.disposition) ? args.disposition : 'New'
      const city = String(args?.city || 'Bangalore').trim()
      const source = ['Direct', 'Manual', 'Meta', 'Website', 'Google ADS'].includes(args?.source)
        ? args.source
        : 'Manual'

      const created = await Lead.create({
        name,
        phone,
        city,
        source,
        disposition,
        notes: args?.notes ? String(args.notes).trim() : undefined,
        owner: new mongoose.Types.ObjectId(ctx.userId),
        ownerName: ctx.userName,
        assignedAt: new Date(),
        assignmentAcknowledged: true, // acknowledged because they made it
      })

      logger.info('Timy: lead created', { userId: ctx.userId, leadId: String(created._id), name, city })
      return {
        success: true,
        leadId: String(created._id),
        name: created.name,
        phone: created.phone,
        disposition: created.disposition,
        owner: created.ownerName,
      }
    },
  },

  update_lead_disposition: {
    declaration: {
      name: 'update_lead_disposition',
      description:
        'Change a lead\'s disposition (status). Always pass an accompanying note explaining the change — that\'s how BuildFlow tracks the why behind every status flip. Reps can only change leads they own; managers can change any.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'Lead ObjectId from find_lead' },
          disposition: {
            type: 'string',
            description:
              'One of: New, Contacted/Open, Qualified, Visit Done, Meeting Done, Negotiation Done, Booking Done, Agreement Done, Failed.',
          },
          note: { type: 'string', description: 'Why is the disposition changing? (1–2 sentences)' },
        },
        required: ['leadId', 'disposition', 'note'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      const disposition = args?.disposition
      if (!DISPOSITIONS.includes(disposition)) {
        return { error: `Disposition must be one of: ${DISPOSITIONS.join(', ')}.` }
      }
      const note = String(args?.note || '').trim()
      if (!note) return { error: 'Please include a short note explaining the change.' }
      const result = await loadMutableLead(String(args?.leadId || ''), ctx)
      if ('error' in result) return result
      const lead = result.lead

      lead.disposition = disposition
      lead.notes = note
      lead.lastActivity = new Date()
      lead.lastActivityNote = note
      lead.statusNotes.push({
        status: disposition,
        note,
        createdAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(ctx.userId),
        createdByName: ctx.userName,
      })
      await lead.save()

      logger.info('Timy: lead disposition updated', {
        userId: ctx.userId,
        leadId: String(lead._id),
        disposition,
      })
      return { success: true, leadId: String(lead._id), disposition }
    },
  },

  add_lead_note: {
    declaration: {
      name: 'add_lead_note',
      description:
        "Append a free-form note to a lead under its current disposition. Use this for general comments where the disposition itself doesn't change.",
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          note: { type: 'string', description: 'The note text' },
        },
        required: ['leadId', 'note'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      const note = String(args?.note || '').trim()
      if (!note) return { error: 'Note text is required.' }
      const result = await loadMutableLead(String(args?.leadId || ''), ctx)
      if ('error' in result) return result
      const lead = result.lead

      lead.statusNotes.push({
        status: lead.disposition,
        note,
        createdAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(ctx.userId),
        createdByName: ctx.userName,
      })
      lead.notes = note
      lead.lastActivity = new Date()
      lead.lastActivityNote = note
      await lead.save()

      logger.info('Timy: lead note added', { userId: ctx.userId, leadId: String(lead._id) })
      return { success: true, leadId: String(lead._id) }
    },
  },

  assign_lead: {
    declaration: {
      name: 'assign_lead',
      description:
        "Manager-only. Assign a lead to a representative. Pass the targetUserId from find_team_member or get_team_overview. Pass null to unassign.",
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          targetUserId: {
            type: 'string',
            description: 'Rep userId to assign to. Use empty string or omit to unassign.',
          },
        },
        required: ['leadId'],
      },
    },
    managerOnly: true,
    mutating: true,
    handler: async (args, ctx) => {
      const result = await loadMutableLead(String(args?.leadId || ''), ctx)
      if ('error' in result) return result
      const lead = result.lead

      const targetId = String(args?.targetUserId || '').trim()
      if (!targetId) {
        // Unassign
        lead.owner = null
        lead.ownerName = null
        lead.assignedAt = null
        lead.assignmentAcknowledged = false
        await lead.save()
        emitToTeam('all', 'lead:unassigned', { leadId: String(lead._id) })
        return { success: true, leadId: String(lead._id), assignedTo: null }
      }
      if (!isValidObjectId(targetId)) return { error: 'Invalid targetUserId.' }
      const rep = await User.findById(targetId).select('name role isActive canReceiveLeads')
      if (!rep || !rep.isActive) return { error: 'Target user not found or inactive.' }
      if (rep.role !== 'representative') return { error: 'Target must be a representative.' }

      lead.owner = rep._id as mongoose.Types.ObjectId
      lead.ownerName = rep.name
      lead.assignedAt = new Date()
      lead.assignmentAcknowledged = false
      await lead.save()
      // Mirror the existing controller's socket pattern so the rep's
      // "New Lead Assigned" popup fires.
      emitToTeam('all', 'lead:assigned', {
        leadId: String(lead._id),
        leadName: lead.name,
        assignedTo: String(rep._id),
        assignedToName: rep.name,
      })

      logger.info('Timy: lead assigned', {
        managerId: ctx.userId,
        leadId: String(lead._id),
        repId: String(rep._id),
      })
      return { success: true, leadId: String(lead._id), assignedTo: rep.name }
    },
  },

  delete_lead: {
    declaration: {
      name: 'delete_lead',
      description:
        'Manager-only. PERMANENTLY delete a lead and all its dependencies (calls, follow-ups, reminders). Confirm explicitly with the user before calling — this cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
        },
        required: ['leadId'],
      },
    },
    managerOnly: true,
    mutating: true,
    handler: async (args, ctx) => {
      if (!isValidObjectId(args?.leadId)) return { error: 'Invalid leadId.' }
      const lead = await Lead.findById(args.leadId)
      if (!lead) return { error: 'Lead not found.' }
      const leadId = lead._id as mongoose.Types.ObjectId
      const leadName = lead.name
      await Promise.all([
        Lead.deleteOne({ _id: leadId }),
        FollowUp.deleteMany({ lead: leadId }),
        Call.deleteMany({ lead: leadId }),
      ])
      emitToTeam('all', 'lead:deleted', { leadId: String(leadId) })
      logger.warn('Timy: lead deleted', { managerId: ctx.userId, leadId: String(leadId), name: leadName })
      return { success: true, deletedLeadName: leadName }
    },
  },

  // ───── WRITE: follow-ups ──────────────────────────────────────────────
  schedule_followup: {
    declaration: {
      name: 'schedule_followup',
      description:
        "Schedule a follow-up on a lead. `scheduledAt` must be an ISO 8601 timestamp in the user's local time, e.g. '2026-04-28T15:00:00+05:30'. Confirm the date/time with the user before calling.",
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          scheduledAt: {
            type: 'string',
            description: 'ISO 8601 timestamp (with timezone), e.g. 2026-04-28T15:00:00+05:30',
          },
          notes: { type: 'string', description: 'Optional reminder context' },
        },
        required: ['leadId', 'scheduledAt'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      const result = await loadMutableLead(String(args?.leadId || ''), ctx)
      if ('error' in result) return result
      const lead = result.lead

      const when = new Date(String(args?.scheduledAt || ''))
      if (Number.isNaN(when.getTime())) {
        return { error: 'scheduledAt is not a valid ISO timestamp.' }
      }
      if (when.getTime() < Date.now() - 60_000) {
        return { error: 'scheduledAt is in the past.' }
      }

      const ownerId = (lead.owner as mongoose.Types.ObjectId | null) || new mongoose.Types.ObjectId(ctx.userId)
      const ownerName = lead.ownerName || ctx.userName

      const fu = await FollowUp.create({
        lead: lead._id,
        leadName: lead.name,
        owner: ownerId,
        ownerName,
        scheduledAt: when,
        notes: args?.notes ? String(args.notes).trim() : undefined,
        status: 'pending',
      })
      await recomputeNextFollowUp(lead._id as mongoose.Types.ObjectId)

      logger.info('Timy: follow-up scheduled', {
        userId: ctx.userId,
        leadId: String(lead._id),
        followUpId: String(fu._id),
        scheduledAt: when,
      })
      return {
        success: true,
        followUpId: String(fu._id),
        leadId: String(lead._id),
        scheduledAt: when,
      }
    },
  },

  complete_followup: {
    declaration: {
      name: 'complete_followup',
      description: "Mark a pending follow-up as completed.",
      parameters: {
        type: 'object',
        properties: {
          followUpId: { type: 'string' },
        },
        required: ['followUpId'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      if (!isValidObjectId(args?.followUpId)) return { error: 'Invalid followUpId.' }
      const fu = await FollowUp.findById(args.followUpId)
      if (!fu) return { error: 'Follow-up not found.' }
      if (
        ctx.userRole === 'representative' &&
        String(fu.owner) !== ctx.userId
      ) {
        return { error: "You don't own this follow-up." }
      }
      fu.status = 'completed'
      fu.completedAt = new Date()
      await fu.save()
      await recomputeNextFollowUp(fu.lead as mongoose.Types.ObjectId)
      logger.info('Timy: follow-up completed', { userId: ctx.userId, followUpId: String(fu._id) })
      return { success: true, followUpId: String(fu._id) }
    },
  },

  cancel_followup: {
    declaration: {
      name: 'cancel_followup',
      description: 'Cancel a pending follow-up (e.g. lead postponed, customer unreachable).',
      parameters: {
        type: 'object',
        properties: {
          followUpId: { type: 'string' },
        },
        required: ['followUpId'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      if (!isValidObjectId(args?.followUpId)) return { error: 'Invalid followUpId.' }
      const fu = await FollowUp.findById(args.followUpId)
      if (!fu) return { error: 'Follow-up not found.' }
      if (
        ctx.userRole === 'representative' &&
        String(fu.owner) !== ctx.userId
      ) {
        return { error: "You don't own this follow-up." }
      }
      fu.status = 'cancelled'
      await fu.save()
      await recomputeNextFollowUp(fu.lead as mongoose.Types.ObjectId)
      logger.info('Timy: follow-up cancelled', { userId: ctx.userId, followUpId: String(fu._id) })
      return { success: true, followUpId: String(fu._id) }
    },
  },

  // ───── WRITE: team / self ─────────────────────────────────────────────
  set_rep_lead_receiving: {
    declaration: {
      name: 'set_rep_lead_receiving',
      description:
        'Manager-only. Block or unblock a representative from receiving newly auto-routed leads. Existing assignments are unaffected.',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: { type: 'string', description: 'Rep userId from find_team_member' },
          accept: {
            type: 'boolean',
            description: 'true = rep keeps receiving leads; false = block them',
          },
        },
        required: ['targetUserId', 'accept'],
      },
    },
    managerOnly: true,
    mutating: true,
    handler: async (args, ctx) => {
      const targetId = String(args?.targetUserId || '').trim()
      if (!isValidObjectId(targetId)) return { error: 'Invalid targetUserId.' }
      const rep = await User.findById(targetId).select('name role canReceiveLeads')
      if (!rep) return { error: 'User not found.' }
      if (rep.role !== 'representative') return { error: 'Target must be a representative.' }
      const accept = Boolean(args?.accept)
      rep.canReceiveLeads = accept
      await rep.save()
      logger.info('Timy: canReceiveLeads toggled', {
        managerId: ctx.userId,
        targetUserId: targetId,
        accept,
      })
      return { success: true, name: rep.name, acceptingNewLeads: accept }
    },
  },

  set_my_availability: {
    declaration: {
      name: 'set_my_availability',
      description:
        "Set the current user's call availability. Only `available` and `offline` are user-controllable; `in-call` is system-managed.",
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['available', 'offline'],
          },
        },
        required: ['status'],
      },
    },
    mutating: true,
    handler: async (args, ctx) => {
      const status = args?.status === 'offline' ? 'offline' : 'available'
      const me = await User.findById(ctx.userId).select('callAvailabilityStatus activeCallSid')
      if (!me) return { error: 'Profile not found.' }
      if (status === 'offline' && (me.activeCallSid || me.callAvailabilityStatus === 'in-call')) {
        return { error: "Can't go offline — a call is still active." }
      }
      me.callAvailabilityStatus = status
      if (status === 'available') me.activeCallSid = null
      await me.save()
      logger.info('Timy: availability changed', { userId: ctx.userId, status })
      return { success: true, status }
    },
  },
}

// ── Public API ─────────────────────────────────────────────────────────────
export const getTimyToolDeclarations = (
  role: 'manager' | 'representative'
): TimyToolDeclaration[] => {
  return Object.values(tools)
    .filter((t) => !t.managerOnly || role === 'manager')
    .map((t) => t.declaration)
}

export const runTimyTool = async (
  name: string,
  args: any,
  ctx: TimyContext
): Promise<any> => {
  const tool = tools[name]
  if (!tool) return { error: `Unknown tool: ${name}` }
  if (tool.managerOnly && ctx.userRole !== 'manager') {
    return { error: 'This tool is manager-only.' }
  }
  if (tool.mutating && ctx.isDemo) {
    return {
      error:
        'This is a demo account — voice changes are read-only. Tell the user the action is blocked because of demo mode.',
    }
  }
  try {
    return await tool.handler(args, ctx)
  } catch (err: any) {
    logger.error('Timy: tool handler threw', { name, err: err?.message })
    return { error: `Tool failed: ${err?.message || 'unknown error'}` }
  }
}

export const buildTimySystemPrompt = (ctx: TimyContext): string => {
  const dateLine = `Today is ${new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}.`

  const langBlock =
    ctx.language === 'hi-IN'
      ? [
          'Language: Hindi (hi-IN). Reply ENTIRELY in natural, conversational Hindi (Devanagari script when transcribed). Use Roman/English only for product names, lead names, phone numbers, and BuildFlow UI labels — everything else in Hindi. Use a warm, respectful tone — “आप” form, never “तू”. Indian numbers should be read in Hindi (e.g. “दो सौ बीस लीड्स”). Mix in common English CRM words the user already uses (“lead”, “follow-up”, “pipeline”) — do not awkwardly translate them.',
        ]
      : ctx.language === 'kn-IN'
      ? [
          'Language: Kannada (kn-IN). Reply ENTIRELY in natural, conversational Kannada (Kannada script when transcribed). Use Roman/English only for product names, lead names, phone numbers, and BuildFlow UI labels — everything else in Kannada. Use a warm, respectful tone — “ನೀವು” form for the user, never “ನೀನು”. Read Indian numbers naturally in Kannada (e.g. “ಇನ್ನೂರಾ ಇಪ್ಪತ್ತು leads”). Keep common English CRM words (“lead”, “follow-up”, “pipeline”, “call”) as-is in English — do not awkwardly translate them. Bengaluru-style polite Kannada is the default register.',
        ]
      : [
          'Language: Indian English (en-IN). Reply in clear, conversational Indian English. Pronounce names, cities, and Indic words naturally — do not switch to American or British accents. Read numbers the Indian way when natural (e.g. "two-twenty leads", "one lakh"). It is fine to drop in common Hindi/Kannada CRM words ("call back karna hai", "site visit", "neevu") if the user uses them.',
        ]

  const historyBlock: string[] = []
  if (ctx.history && ctx.history.length > 0) {
    historyBlock.push(
      'Previous conversation (the user just reconnected — likely a language switch). Continue from here, do NOT start over with a fresh greeting unless the user asks for one:'
    )
    for (const turn of ctx.history) {
      const speaker = turn.role === 'user' ? ctx.userName : 'You (Timy)'
      const text = turn.text.slice(0, 600)
      historyBlock.push(`${speaker}: ${text}`)
    }
    historyBlock.push('')
  }

  const roleScope =
    ctx.userRole === 'manager'
      ? 'You can read across the whole team and act on any lead, rep, or follow-up.'
      : 'You can only act on leads owned by this representative. The tools enforce this; do not try to operate on other reps\' data.'

  return [
    `You are Timy AI, BuildFlow's hands-free voice assistant. You're talking with ${ctx.userName}, who is a ${ctx.userRole}.`,
    dateLine,
    '',
    ...langBlock,
    '',
    ...historyBlock,
    'Capabilities:',
    '- You can BOTH read AND act on BuildFlow data via tools — search leads, change a lead\'s disposition with a note, schedule and complete follow-ups, add notes, create new leads, assign leads to reps (manager), block reps from new leads (manager), set your own availability, and (manager only) delete a lead.',
    `- ${roleScope}`,
    '',
    'How to act safely (this is critical):',
    '- Always look up first, act second. To mutate a lead/team-member, you need a leadId / userId. Get those by calling find_lead, find_team_member, get_today_followups, get_overdue_followups, or get_team_overview FIRST.',
    '- Confirm destructive or hard-to-reverse actions verbally before calling the tool: deleting a lead, changing a disposition to "Failed" or "Booking Done", reassigning ownership, scheduling for a date that\'s far away, or going offline. Re-state what you are about to do in one sentence and wait for a yes/ok.',
    '- For any disposition change, the update_lead_disposition tool requires a short note. If the user didn\'t volunteer one, ask once ("What note should I attach?") then proceed with their answer.',
    '- For phone numbers and dates, repeat back what you heard before creating ("So that\'s 9-8-7-6-5-4-3-2-1-0, correct?") because the model can mishear digits over voice.',
    '- ISO timestamps for schedule_followup must be in the user\'s local time with the +05:30 offset (Indian Standard Time). Resolve "tomorrow at 3 pm" → 2026-04-28T15:00:00+05:30 yourself.',
    '- After a successful action, briefly confirm the change ("Done — Mahesh\'s lead is now Visit Done. Note saved."). Do NOT read back the raw tool output.',
    '- If a tool returns an `error`, paraphrase it in plain language and offer next steps. Never claim something happened if a tool reported an error.',
    `${ctx.isDemo ? '- This is a DEMO account: every write tool will refuse with an error. If the user asks for an action, politely tell them this account is view-only.\n' : ''}`,
    'Conversation style:',
    '- Conversational, brief, warm — like a sharp colleague on a phone call. No markdown, no bullet symbols when speaking. Round counts ("about two-twenty leads"). Offer one obvious follow-up question only when it adds value.',
    '- If a tool returns zero results, say so plainly — don\'t pad the answer.',
    '',
    'Language switching:',
    `- Current voice language is ${
      ctx.language === 'hi-IN'
        ? 'Hindi (hi-IN, male voice)'
        : ctx.language === 'kn-IN'
        ? 'Kannada (kn-IN, female voice)'
        : 'Indian English (en-IN, female voice)'
    }.`,
    "- Supported languages: en-IN, hi-IN, kn-IN. If the user EVER asks to switch, CALL the switch_language tool — never just start replying in the new language without calling it (the voice itself only changes after the relay reconnects).",
    "- After calling switch_language, give a one-line confirmation in the OLD language ('OK, switching…') and stop. The next turn will already be in the new language with the new voice.",
    '- When the session reconnects after a language switch, the previous conversation will be replayed to you above as context. Continue smoothly — do NOT re-greet.',
    '',
    'Session start:',
    `- The very first user turn in a fresh session will be the literal token "<<session_start>>". That is NOT a real user message — it's a signal from the relay that ${ctx.userName} just opened the Timy panel. When you see it, ignore the token entirely (do not echo, quote, or acknowledge it) and instead open with a warm one-line greeting that addresses ${ctx.userName} by first name and offers help. Then stop and wait for their reply. Do this exactly once per session.`,
    ctx.language === 'hi-IN'
      ? `- Hindi greeting examples (vary the wording — don't repeat verbatim): "नमस्ते ${ctx.userName.split(' ')[0]}, Timy यहाँ — आज क्या help चाहिए?" / "हे ${ctx.userName.split(' ')[0]}, बताइए, आज क्या करना है?"`
      : ctx.language === 'kn-IN'
      ? `- Kannada greeting examples (vary the wording): "ನಮಸ್ಕಾರ ${ctx.userName.split(' ')[0]}, ನಾನು Timy — ಇಂದು ನಾನು ಏನು ಸಹಾಯ ಮಾಡಲಿ?" / "ಹೇ ${ctx.userName.split(' ')[0]}, ಹೇಳಿ, ಏನು ಮಾಡಬೇಕು?"`
      : `- English greeting examples (vary the wording — don't repeat verbatim): "Hey ${ctx.userName.split(' ')[0]}, Timy here — what can I help you with?" / "Hi ${ctx.userName.split(' ')[0]}, ready when you are. What's on the list today?"`,
    '',
    'Tone:',
    '- Acknowledge before long lookups or writes ("One sec, updating that…" / "एक सेकंड, अपडेट कर रहा हूँ…" / "ಒಂದು ಕ್ಷಣ, ಅಪ್ಡೇಟ್ ಮಾಡ್ತಿದೀನಿ…").',
    '- End answers crisply.',
  ].join('\n')
}
