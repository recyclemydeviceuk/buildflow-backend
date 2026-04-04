import { Lead } from '../models/Lead'
import { Call } from '../models/Call'

export const buildLeadPipelineReport = async (dateFrom?: string, dateTo?: string) => {
  const matchStage: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    matchStage.createdAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  const [byDisposition, bySource, byCity, byCampaign] = await Promise.all([
    Lead.aggregate([
      { $match: matchStage },
      { $group: { _id: '$disposition', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Lead.aggregate([
      { $match: matchStage },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Lead.aggregate([
      { $match: matchStage },
      { $group: { _id: '$city', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Lead.aggregate([
      { $match: { ...matchStage, campaign: { $ne: null } } },
      { $group: { _id: '$campaign', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ])

  return { byDisposition, bySource, byCity, byCampaign }
}

export const buildCallActivityReport = async (dateFrom?: string, dateTo?: string) => {
  const matchStage: Record<string, unknown> = {}
  if (dateFrom || dateTo) {
    matchStage.startedAt = {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    }
  }

  const [byOutcome, byRep, dailyVolume] = await Promise.all([
    Call.aggregate([
      { $match: matchStage },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Call.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$representative',
          name: { $first: '$representativeName' },
          total: { $sum: 1 },
          connected: { $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } },
          totalDuration: { $sum: '$duration' },
        },
      },
      { $sort: { total: -1 } },
    ]),
    Call.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } },
          count: { $sum: 1 },
          connected: { $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ])

  return { byOutcome, byRep, dailyVolume }
}
