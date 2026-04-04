import { Request, Response, NextFunction } from 'express'
import { Lead } from '../models/Lead'
import { Call } from '../models/Call'
import { Reminder } from '../models/Reminder'
import { User } from '../models/User'
import { Settings } from '../models/Settings'
import { refreshReminderStatuses } from '../services/reminder.service'
import { normalizeFeatureControls } from '../utils/featureControls'

const startOfDay = (date: Date) => {
  const value = new Date(date)
  value.setHours(0, 0, 0, 0)
  return value
}

const endOfDay = (date: Date) => {
  const value = new Date(date)
  value.setHours(23, 59, 59, 999)
  return value
}

const startOfWeek = (date: Date) => {
  const value = startOfDay(date)
  const day = value.getDay()
  const diff = day === 0 ? 6 : day - 1
  value.setDate(value.getDate() - diff)
  return value
}

const computeRepScore = (params: {
  callsToday: number
  callsTarget: number
  leadsAssigned: number
  leadsContacted: number
  qualifiedThisWeek: number
  overdueReminders: number
}) => {
  const callsProgress = Math.min(params.callsToday / Math.max(params.callsTarget, 1), 1) * 45
  const contactProgress =
    params.leadsAssigned > 0 ? Math.min(params.leadsContacted / params.leadsAssigned, 1) * 25 : 0
  const qualifiedProgress = Math.min(params.qualifiedThisWeek / 5, 1) * 20
  const overduePenalty = Math.min(params.overdueReminders * 5, 20)

  return Math.max(0, Math.min(100, Math.round(10 + callsProgress + contactProgress + qualifiedProgress - overduePenalty)))
}

const buildStartedAtMatch = (dateFrom?: string, dateTo?: string) => {
  if (!dateFrom && !dateTo) return {}

  return {
    startedAt: {
      ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { $lte: new Date(dateTo) } : {}),
    },
  }
}

const buildLeadCreatedAtMatch = (dateFrom?: string, dateTo?: string) => {
  if (!dateFrom && !dateTo) return {}

  return {
    createdAt: {
      ...(dateFrom ? { $gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { $lte: new Date(dateTo) } : {}),
    },
  }
}

export const getRepresentativePerformanceDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>
    const callDateMatch = buildStartedAtMatch(dateFrom, dateTo)
    const leadDateMatch = buildLeadCreatedAtMatch(dateFrom, dateTo)
    const representativeId = req.user!.id

    const [
      totalCalls,
      connectedCalls,
      avgDurationResult,
      sourcePerformance,
      repCallPerformance,
      repLeadPerformance,
      representatives,
    ] = await Promise.all([
      Call.countDocuments({ representative: representativeId, ...callDateMatch }),
      Call.countDocuments({ representative: representativeId, outcome: 'Connected', ...callDateMatch }),
      Call.aggregate([
        { $match: { representative: representativeId, ...callDateMatch } as any },
        {
          $group: {
            _id: null,
            avgDuration: { $avg: '$duration' },
          },
        },
      ]),
      Lead.aggregate([
        { $match: { owner: representativeId, ...leadDateMatch } as any },
        {
          $group: {
            _id: '$source',
            totalLeads: { $sum: 1 },
            qualifiedLeads: {
              $sum: { $cond: [{ $eq: ['$disposition', 'Qualified'] }, 1, 0] },
            },
            wonLeads: {
              $sum: { $cond: [{ $eq: ['$disposition', 'Agreement Done'] }, 1, 0] },
            },
          },
        },
        {
          $project: {
            _id: 0,
            source: '$_id',
            totalLeads: 1,
            qualifiedLeads: 1,
            wonLeads: 1,
            conversionRate: {
              $cond: [
                { $gt: ['$totalLeads', 0] },
                { $multiply: [{ $divide: ['$wonLeads', '$totalLeads'] }, 100] },
                0,
              ],
            },
          },
        },
        { $sort: { totalLeads: -1, source: 1 } },
      ]),
      Call.aggregate([
        { $match: callDateMatch },
        {
          $group: {
            _id: '$representative',
            representativeName: { $first: '$representativeName' },
            totalCalls: { $sum: 1 },
            connectedCalls: {
              $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] },
            },
            totalDuration: { $sum: '$duration' },
            avgDuration: { $avg: '$duration' },
          },
        },
      ]),
      Lead.aggregate([
        { $match: leadDateMatch },
        {
          $group: {
            _id: '$owner',
            totalLeads: { $sum: 1 },
            qualifiedLeads: {
              $sum: { $cond: [{ $eq: ['$disposition', 'Qualified'] }, 1, 0] },
            },
            wonLeads: {
              $sum: { $cond: [{ $eq: ['$disposition', 'Agreement Done'] }, 1, 0] },
            },
          },
        },
      ]),
      User.find({ role: 'representative', isActive: true }).select('name phone avatarUrl').lean(),
    ])

    const leadPerformanceMap = new Map(repLeadPerformance.map((item) => [String(item._id), item]))
    const callPerformanceMap = new Map(repCallPerformance.map((item) => [String(item._id), item]))

    const leaderboard = representatives
      .map((rep) => {
        const callStats = callPerformanceMap.get(String(rep._id))
        const leadStats = leadPerformanceMap.get(String(rep._id))
        const callsMade = Number(callStats?.totalCalls || 0)
        const connected = Number(callStats?.connectedCalls || 0)
        const qualifiedLeads = Number(leadStats?.qualifiedLeads || 0)
        const wonLeads = Number(leadStats?.wonLeads || 0)
        const totalLeadsForRange = Number(leadStats?.totalLeads || 0)
        const conversionRate = totalLeadsForRange > 0 ? (wonLeads / totalLeadsForRange) * 100 : 0
        const connectRate = callsMade > 0 ? (connected / callsMade) * 100 : 0
        const score = Math.round(
          Math.min(100, callsMade) * 0.2 +
            Math.min(connectRate, 100) * 0.4 +
            Math.min(conversionRate, 100) * 0.4
        )

        return {
          id: String(rep._id),
          representativeName: rep.name,
          phone: rep.phone || '',
          avatarUrl: rep.avatarUrl || null,
          totalCalls: callsMade,
          connectedCalls: connected,
          qualifiedLeads,
          wonLeads,
          conversionRate: Number(conversionRate.toFixed(1)),
          avgDuration: Math.floor(Number(callStats?.avgDuration || 0)),
          score,
        }
      })
      .sort((a, b) => b.totalCalls - a.totalCalls || b.score - a.score || a.representativeName.localeCompare(b.representativeName))
      .map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }))

    const myLeadStats = leadPerformanceMap.get(String(representativeId))
    const qualifiedLeads = Number(myLeadStats?.qualifiedLeads || 0)
    const wonLeads = Number(myLeadStats?.wonLeads || 0)
    const totalLeadsForRange = Number(myLeadStats?.totalLeads || 0)
    const conversionRate = totalLeadsForRange > 0 ? (wonLeads / totalLeadsForRange) * 100 : 0

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalCalls,
          connectedCalls,
          qualifiedLeads,
          wonLeads,
          conversionRate: Number(conversionRate.toFixed(1)),
          avgCallDuration: Math.floor(Number(avgDurationResult[0]?.avgDuration || 0)),
        },
        sourcePerformance,
        leaderboard,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getRepresentativeDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await refreshReminderStatuses()

    const now = new Date()
    const todayStart = startOfDay(now)
    const todayEnd = endOfDay(now)
    const weekStart = startOfWeek(now)
    const callsTarget = 20

    const representatives = await User.find({
      role: 'representative',
      isActive: true,
    }).select('name role phone avatarUrl')

    const repIds = representatives.map((rep) => rep._id)

    const [leadCounts, callCounts, reminderCounts, myLeads, myReminders, settings] = await Promise.all([
      Lead.aggregate([
        { $match: { owner: { $in: repIds } } },
        {
          $group: {
            _id: '$owner',
            leadsAssigned: { $sum: 1 },
            leadsContacted: {
              $sum: {
                $cond: [{ $ne: ['$disposition', 'New'] }, 1, 0],
              },
            },
            qualifiedThisWeek: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$disposition', 'Qualified'] },
                      { $gte: ['$updatedAt', weekStart] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      Call.aggregate([
        {
          $match: {
            representative: { $in: repIds },
            $or: [
              { startedAt: { $gte: todayStart, $lte: todayEnd } },
              {
                $and: [
                  { startedAt: null },
                  { createdAt: { $gte: todayStart, $lte: todayEnd } },
                ],
              },
            ],
          },
        },
        {
          $group: {
            _id: '$representative',
            callsToday: { $sum: 1 },
            connectedCallsToday: {
              $sum: {
                $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0],
              },
            },
          },
        },
      ]),
      Reminder.aggregate([
        {
          $match: {
            owner: { $in: repIds },
            status: { $ne: 'completed' },
          },
        },
        {
          $group: {
            _id: '$owner',
            overdueReminders: {
              $sum: {
                $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0],
              },
            },
            dueSoonReminders: {
              $sum: {
                $cond: [{ $eq: ['$status', 'due_soon'] }, 1, 0],
              },
            },
            activeReminders: { $sum: 1 },
          },
        },
      ]),
      Lead.find(req.user!.role === 'representative' ? { owner: req.user!.id } : {})
        .sort({ updatedAt: -1 })
        .limit(6)
        .lean(),
      Reminder.find(
        req.user!.role === 'representative'
          ? { owner: req.user!.id, status: { $ne: 'completed' } }
          : { status: { $ne: 'completed' } }
      )
        .sort({ dueAt: 1 })
        .limit(5)
        .lean(),
      Settings.findOne().lean(),
    ])

    const leadMap = new Map(leadCounts.map((item) => [String(item._id), item]))
    const callMap = new Map(callCounts.map((item) => [String(item._id), item]))
    const reminderMap = new Map(reminderCounts.map((item) => [String(item._id), item]))

    const leaderboard = representatives
      .map((rep) => {
        const leadStats = leadMap.get(String(rep._id))
        const callStats = callMap.get(String(rep._id))
        const reminderStats = reminderMap.get(String(rep._id))

        const callsToday = Number(callStats?.callsToday || 0)
        const connectedCallsToday = Number(callStats?.connectedCallsToday || 0)
        const leadsAssigned = Number(leadStats?.leadsAssigned || 0)
        const leadsContacted = Number(leadStats?.leadsContacted || 0)
        const qualifiedThisWeek = Number(leadStats?.qualifiedThisWeek || 0)
        const overdueReminders = Number(reminderStats?.overdueReminders || 0)
        const dueSoonReminders = Number(reminderStats?.dueSoonReminders || 0)
        const activeReminders = Number(reminderStats?.activeReminders || 0)
        const score = computeRepScore({
          callsToday,
          callsTarget,
          leadsAssigned,
          leadsContacted,
          qualifiedThisWeek,
          overdueReminders,
        })

        return {
          id: String(rep._id),
          name: rep.name,
          phone: rep.phone || '',
          avatarUrl: rep.avatarUrl || null,
          callsToday,
          connectedCallsToday,
          leadsAssigned,
          leadsContacted,
          qualifiedThisWeek,
          overdueReminders,
          dueSoonReminders,
          activeReminders,
          score,
        }
      })
      .sort((a, b) => b.score - a.score || b.callsToday - a.callsToday || a.name.localeCompare(b.name))
      .map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }))

    const currentRep =
      leaderboard.find((entry) => entry.id === String(req.user!.id)) ||
      (req.user!.role === 'representative'
        ? {
            id: String(req.user!.id),
            name: req.user!.name,
            phone: req.user!.phone || '',
            avatarUrl: null,
            callsToday: 0,
            connectedCallsToday: 0,
            leadsAssigned: 0,
            leadsContacted: 0,
            qualifiedThisWeek: 0,
            overdueReminders: 0,
            dueSoonReminders: 0,
            activeReminders: 0,
            score: computeRepScore({
              callsToday: 0,
              callsTarget,
              leadsAssigned: 0,
              leadsContacted: 0,
              qualifiedThisWeek: 0,
              overdueReminders: 0,
            }),
            rank: leaderboard.length + 1,
          }
        : null)

    return res.status(200).json({
      success: true,
      data: {
        summary: currentRep,
        callsTarget,
        manualAssignmentEnabled: normalizeFeatureControls(
          settings?.featureControls,
          settings?.leadRouting?.mode
        ).manualAssignment,
        leads: myLeads,
        reminders: myReminders,
        leaderboard: leaderboard.slice(0, 5),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getKPIs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const dateFilter = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }

    const createdAtFilter = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}

    const [
      totalLeads,
      qualifiedLeads,
      wonLeads,
      totalCalls,
      connectedCalls,
    ] = await Promise.all([
      Lead.countDocuments(createdAtFilter),
      Lead.countDocuments({ ...createdAtFilter, disposition: 'Qualified' }),
      Lead.countDocuments({ ...createdAtFilter, disposition: 'Agreement Done' }),
      Call.countDocuments(createdAtFilter),
      Call.countDocuments({ ...createdAtFilter, outcome: 'Connected' }),
    ])

    const conversionRate = totalLeads > 0 ? ((wonLeads / totalLeads) * 100).toFixed(1) : '0'
    const callConnectRate = totalCalls > 0 ? ((connectedCalls / totalCalls) * 100).toFixed(1) : '0'

    return res.status(200).json({
      success: true,
      data: {
        totalLeads,
        qualifiedLeads,
        wonLeads,
        totalCalls,
        connectedCalls,
        conversionRate: parseFloat(conversionRate),
        callConnectRate: parseFloat(callConnectRate),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getSourcePerformance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const matchStage: Record<string, unknown> = {}
    if (dateFrom || dateTo) {
      matchStage.createdAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }

    const result = await Lead.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$source',
          totalLeads: { $sum: 1 },
          wonLeads: { $sum: { $cond: [{ $eq: ['$disposition', 'Agreement Done'] }, 1, 0] } },
          qualifiedLeads: { $sum: { $cond: [{ $eq: ['$disposition', 'Qualified'] }, 1, 0] } },
        },
      },
      {
        $project: {
          source: '$_id',
          totalLeads: 1,
          wonLeads: 1,
          qualifiedLeads: 1,
          conversionRate: {
            $cond: [
              { $gt: ['$totalLeads', 0] },
              { $multiply: [{ $divide: ['$wonLeads', '$totalLeads'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { totalLeads: -1 } },
    ])

    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getUtmPerformance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const matchStage: Record<string, unknown> = { utmSource: { $exists: true, $ne: null } }
    if (dateFrom || dateTo) {
      matchStage.createdAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }

    const result = await Lead.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            utmSource: '$utmSource',
            utmMedium: '$utmMedium',
            utmCampaign: '$utmCampaign',
          },
          totalLeads: { $sum: 1 },
          wonLeads: { $sum: { $cond: [{ $eq: ['$disposition', 'Agreement Done'] }, 1, 0] } },
        },
      },
      { $sort: { totalLeads: -1 } },
      { $limit: 50 },
    ])

    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getConversionFunnel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const matchStage: Record<string, unknown> = {}
    if (dateFrom || dateTo) {
      matchStage.createdAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }

    const stages = ['New', 'Contacted/Open', 'Qualified', 'Visit Done', 'Meeting Done', 'Negotiation Done', 'Booking Done', 'Agreement Done', 'Failed']

    const result = await Lead.aggregate([
      { $match: matchStage },
      { $group: { _id: '$disposition', count: { $sum: 1 } } },
    ])

    const funnelMap: Record<string, number> = {}
    result.forEach((r) => { funnelMap[r._id] = r.count })

    const funnel = stages.map((stage) => ({
      stage,
      count: funnelMap[stage] || 0,
    }))

    return res.status(200).json({ success: true, data: funnel })
  } catch (err) {
    next(err)
  }
}

export const getRepPerformance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const matchStage: Record<string, unknown> = {}
    if (dateFrom || dateTo) {
      matchStage.startedAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }

    const result = await Call.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$representative',
          representativeName: { $first: '$representativeName' },
          totalCalls: { $sum: 1 },
          connectedCalls: { $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } },
          totalDuration: { $sum: '$duration' },
          avgDuration: { $avg: '$duration' },
        },
      },
      { $sort: { totalCalls: -1 } },
    ])

    return res.status(200).json({
      success: true,
      data: result.map((item) => ({
        ...item,
        totalDuration: Math.floor(Number(item.totalDuration ?? 0)),
        avgDuration: Math.floor(Number(item.avgDuration ?? 0)),
      })),
    })
  } catch (err) {
    next(err)
  }
}
