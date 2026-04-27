/**
 * Timy AI tool registry.
 *
 * Each tool has two parts:
 *  - `declaration`: the JSON-schema-ish blob we pass to Gemini Live so the
 *    model knows what it can call.
 *  - `handler`:     the server-side function that actually queries MongoDB
 *    when Gemini decides to invoke the tool.
 *
 * Permissions: representatives only ever see their own data. Managers see
 * the whole org. We enforce that here, NOT on the model side, so a
 * jail-broken prompt can't leak data across reps.
 */
import mongoose from 'mongoose'
import { Lead } from '../../models/Lead'
import { User } from '../../models/User'
import { FollowUp } from '../../models/FollowUp'
import { Call } from '../../models/Call'

export interface TimyContext {
  userId: string
  userName: string
  userRole: 'manager' | 'representative'
  isDemo: boolean
  /** Voice + reply language. Defaults to Indian English. */
  language: 'en-IN' | 'hi-IN'
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

// ── Tools ──────────────────────────────────────────────────────────────────
const tools: Record<string, Tool> = {
  find_lead: {
    declaration: {
      name: 'find_lead',
      description:
        'Search leads by name fragment or phone number. Returns up to 5 matches with disposition, owner, follow-up, and last activity.',
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
        .select('name phone city disposition source ownerName nextFollowUp updatedAt')
        .lean()
      return {
        count: leads.length,
        leads: leads.map((l) => ({
          name: l.name,
          phone: l.phone,
          city: l.city,
          disposition: l.disposition,
          source: l.source,
          owner: l.ownerName,
          nextFollowUp: l.nextFollowUp,
          lastUpdate: l.updatedAt,
        })),
      }
    },
  },

  list_recent_leads: {
    declaration: {
      name: 'list_recent_leads',
      description:
        'List the most recently created or updated leads. Use this when the user asks "what leads came in today" or "show me the latest leads".',
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
      return { count: leads.length, leads }
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

  get_today_followups: {
    declaration: {
      name: 'get_today_followups',
      description: "Return today's pending follow-ups for the current user (or for the whole team if the user is a manager).",
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
        .select('leadName ownerName scheduledAt notes')
        .lean()
      return { count: list.length, followUps: list }
    },
  },

  get_overdue_followups: {
    declaration: {
      name: 'get_overdue_followups',
      description:
        'Return overdue (a.k.a. ignored) pending follow-ups whose scheduled time has passed. Helpful when the rep asks "what did I miss?".',
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
        .select('leadName ownerName scheduledAt notes')
        .lean()
      return { count: list.length, overdue: list }
    },
  },

  get_my_recent_calls: {
    declaration: {
      name: 'get_my_recent_calls',
      description: 'Return the user\'s most recent calls (incoming + outbound). Reps see their own; managers see the team.',
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
        'Manager-only. Returns each active representative with their availability, whether they are accepting new leads, and how many leads they currently own.',
      parameters: { type: 'object', properties: {} },
    },
    managerOnly: true,
    handler: async (_args, _ctx) => {
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
  return tool.handler(args, ctx)
}

export const buildTimySystemPrompt = (ctx: TimyContext): string => {
  const dateLine = `Today is ${new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}.`

  const isHindi = ctx.language === 'hi-IN'

  // Language block tells Gemini what to speak in. We keep the rest of the
  // prompt in English because the model follows English instructions more
  // reliably than Hindi-only ones, but the *spoken output* is governed by
  // these explicit rules and the speechConfig.languageCode at the API level.
  const langBlock = isHindi
    ? [
        'Language: Hindi (hi-IN). Reply ENTIRELY in natural, conversational Hindi (Devanagari script when transcribed). Use Roman/English only for product names, lead names, phone numbers, and BuildFlow UI labels — everything else in Hindi. Use a warm, respectful tone — “आप” form, never “तू”. Indian numbers should be read in Hindi (e.g. “दो सौ बीस लीड्स”). Mix in common English CRM words the user already uses (“lead”, “follow-up”, “pipeline”) — do not awkwardly translate them.',
      ]
    : [
        'Language: Indian English (en-IN). Reply in clear, conversational Indian English. Pronounce names, cities, and Hindi words naturally — do not switch to American or British accents. Read numbers the Indian way when natural (e.g. "two-twenty leads", "one lakh"). It is fine to drop in common Hindi CRM words ("call back karna hai", "site visit") if the user uses them.',
      ]

  return [
    `You are Timy AI, BuildFlow's friendly voice assistant. You're talking with ${ctx.userName}, who is a ${ctx.userRole}.`,
    dateLine,
    '',
    ...langBlock,
    '',
    'Goals:',
    '- Help the user get essential CRM information (leads, follow-ups, calls, team performance) in seconds, hands-free.',
    '- Be conversational, brief, and warm. Speak like a helpful colleague — short sentences, natural pacing, no markdown, no bullet symbols when speaking.',
    '- Always use tools to fetch real data — never guess or fabricate numbers, names, or phone numbers.',
    '- After a tool returns, summarize naturally. Round counts, and offer one obvious follow-up question if useful (e.g. "Want me to read out the next three?" or "अगले तीन सुनना है?").',
    '',
    'Constraints:',
    '- You can only READ data today. If the user asks you to delete, edit, or update something, tell them politely you can only fetch information and they should use the BuildFlow UI to make changes.',
    '- If the user is a representative, only quote data about them. The tools enforce this; do not try to ask about other reps\' leads.',
    '- If a tool returns zero results, say so plainly — don\'t pad the answer.',
    '',
    'Tone:',
    isHindi
      ? '- शुरुआत में छोटा-सा नमस्ते करें (e.g. "नमस्ते, Timy बोल रहा हूँ — आप क्या जानना चाहेंगे?"), फिर रुकें।'
      : '- Greet briefly when the session opens (e.g. "Hi, Timy here — what can I look up for you?"), then wait.',
    '- Acknowledge the user before running long lookups ("One sec, checking…" / "एक सेकंड, देख रहा हूँ…").',
    '- End answers crisply.',
  ].join('\n')
}
