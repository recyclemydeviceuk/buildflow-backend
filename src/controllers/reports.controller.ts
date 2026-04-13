import { Request, Response, NextFunction } from 'express'
import { Lead } from '../models/Lead'
import { Call } from '../models/Call'

const buildDateFilter = (dateFrom?: string, dateTo?: string) => {
  if (!dateFrom && !dateTo) return {}
  return {
    createdAt: {
      ...(dateFrom && { $gte: new Date(dateFrom) }),
      ...(dateTo && { $lte: new Date(dateTo) }),
    },
  }
}

export const getLeadPipelineReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

    const [byDisposition, bySource, byCity] = await Promise.all([
      Lead.aggregate([
        { $match: buildDateFilter(dateFrom, dateTo) },
        { $group: { _id: '$disposition', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Lead.aggregate([
        { $match: buildDateFilter(dateFrom, dateTo) },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Lead.aggregate([
        { $match: buildDateFilter(dateFrom, dateTo) },
        { $group: { _id: '$city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ])

    return res.status(200).json({
      success: true,
      data: { byDisposition, bySource, byCity },
    })
  } catch (err) {
    next(err)
  }
}

export const getCallActivityReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo } = req.query as Record<string, string>

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
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$startedAt' },
            },
            count: { $sum: 1 },
            connected: { $sum: { $cond: [{ $eq: ['$outcome', 'Connected'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ])

    return res.status(200).json({
      success: true,
      data: { byOutcome, byRep, dailyVolume },
    })
  } catch (err) {
    next(err)
  }
}

export const exportLeadsCSV = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo, source, disposition } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}
    if (dateFrom || dateTo) {
      filter.createdAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }
    if (source) filter.source = source
    if (disposition) filter.disposition = disposition

    const leads = await Lead.find(filter).sort({ createdAt: -1 }).limit(10000).lean()

    const headers = [
      'id', 'name', 'phone', 'email', 'city', 'source', 'disposition',
      'owner', 'budget', 'plotOwned', 'buildType', 'campaign',
      'utmSource', 'utmMedium', 'utmCampaign', 'createdAt',
    ]

    const rows = leads.map((lead) =>
      headers.map((h) => {
        const val = (lead as Record<string, unknown>)[h]
        if (val === null || val === undefined) return ''
        if (val instanceof Date) return val.toISOString()
        return String(val).replace(/,/g, ' ')
      }).join(',')
    )

    const csv = [headers.join(','), ...rows].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="leads_export.csv"')
    return res.status(200).send(csv)
  } catch (err) {
    next(err)
  }
}

export const exportCallsCSV = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo, representative } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}
    if (dateFrom || dateTo) {
      filter.startedAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }
    if (representative) filter.representative = representative

    const calls = await Call.find(filter).sort({ startedAt: -1 }).limit(10000).lean()

    const headers = [
      'id', 'leadName', 'phone', 'representativeName', 'outcome', 'stage',
      'duration', 'startedAt', 'endedAt', 'recordingUrl', 'notes',
    ]

    const rows = calls.map((call) =>
      headers.map((h) => {
        const val = (call as Record<string, unknown>)[h]
        if (val === null || val === undefined) return ''
        if (val instanceof Date) return val.toISOString()
        return String(val).replace(/,/g, ' ')
      }).join(',')
    )

    const csv = [headers.join(','), ...rows].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="calls_export.csv"')
    return res.status(200).send(csv)
  } catch (err) {
    next(err)
  }
}
