import { Lead } from '../models/Lead'
import { Call } from '../models/Call'

export const computeKPIs = async (dateFrom?: string, dateTo?: string) => {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    dateFilter.createdAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  const callFilter: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    callFilter.startedAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  const [totalLeads, newLeads, wonLeads, totalCalls, connectedCalls, callDuration] = await Promise.all([
    Lead.countDocuments(dateFilter),
    Lead.countDocuments({ ...dateFilter, disposition: 'New' }),
    Lead.countDocuments({ ...dateFilter, disposition: 'Agreement Done' }),
    Call.countDocuments(callFilter),
    Call.countDocuments({ ...callFilter, outcome: 'Connected' }),
    Call.aggregate([
      { $match: callFilter },
      { $group: { _id: null, total: { $sum: '$duration' }, avg: { $avg: '$duration' } } },
    ]),
  ])

  const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0
  const connectionRate = totalCalls > 0 ? Math.round((connectedCalls / totalCalls) * 100) : 0
  const avgCallDuration = callDuration[0]?.avg || 0

  return {
    totalLeads,
    newLeads,
    wonLeads,
    totalCalls,
    connectedCalls,
    conversionRate,
    connectionRate,
    avgCallDuration: Math.round(avgCallDuration),
  }
}

export const getSourceStats = async (dateFrom?: string, dateTo?: string) => {
  const matchStage: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    matchStage.createdAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  return Lead.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$source',
        total: { $sum: 1 },
        won: { $sum: { $cond: [{ $eq: ['$disposition', 'Agreement Done'] }, 1, 0] } },
        lost: { $sum: { $cond: [{ $eq: ['$disposition', 'Failed'] }, 1, 0] } },
      },
    },
    { $sort: { total: -1 } },
  ])
}

export const getRepStats = async (dateFrom?: string, dateTo?: string) => {
  const matchStage: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    matchStage.startedAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  return Call.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$representative',
        name: { $first: '$representativeName' },
        totalCalls: { $sum: 1 },
        connected: { $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } },
        totalDuration: { $sum: '$duration' },
        avgDuration: { $avg: '$duration' },
      },
    },
    { $sort: { totalCalls: -1 } },
  ])
}
