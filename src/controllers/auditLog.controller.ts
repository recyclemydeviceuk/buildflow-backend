import { Request, Response, NextFunction } from 'express'
import { AuditLog } from '../models/AuditLog'
import { LEAD_TRANSFER_ACTIONS, normalizeLeadTransferLog } from '../utils/leadTransferHistory'

const LEAD_DISPOSITIONS = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost', 'Not Interested', 'Invalid']

export const getAuditLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = '1',
      limit = '50',
      actor,
      actorRole,
      action,
      leadStatus,
      entity,
      entityId,
      dateFrom,
      dateTo,
      search,
    } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}

    if (actor) filter.actor = actor
    if (actorRole) filter.actorRole = actorRole
    if (action) filter.action = action
    if (leadStatus) {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { 'before.disposition': leadStatus },
            { 'after.disposition': leadStatus },
          ],
        },
      ]
    }
    if (entity) filter.entity = entity
    if (entityId) filter.entityId = entityId
    if (search) {
      filter.$or = [
        { actorName: { $regex: search, $options: 'i' } },
        { action: { $regex: search, $options: 'i' } },
        { entity: { $regex: search, $options: 'i' } },
        { actorRole: { $regex: search, $options: 'i' } },
      ]
    }
    if (dateFrom || dateTo) {
      filter.createdAt = {
        ...(dateFrom && { $gte: new Date(dateFrom) }),
        ...(dateTo && { $lte: new Date(dateTo) }),
      }
    }

    const pageNum = Math.max(1, parseInt(page))
    const limitNum = Math.min(100, parseInt(limit))
    const skip = (pageNum - 1) * limitNum

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      AuditLog.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

export const getAuditLogFilters = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [actions, roles] = await Promise.all([
      AuditLog.distinct('action'),
      AuditLog.distinct('actorRole'),
    ])

    const normalizedActions = actions
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .sort((a, b) => a.localeCompare(b))

    const normalizedRoles = roles
      .filter((value): value is string => typeof value === 'string' && ['manager', 'representative'].includes(value))
      .sort((a, b) => a.localeCompare(b))

    return res.status(200).json({
      success: true,
      data: {
        actions: normalizedActions,
        roles: normalizedRoles,
        leadStatuses: LEAD_DISPOSITIONS,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getLeadTransferHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = '1',
      limit = '25',
      search,
      type,
      actorRole,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>

    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25))
    const validTypes = ['assignment', 'transfer', 'unassignment']
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid transfer type' })
    }
    if (actorRole && !['manager', 'representative'].includes(actorRole)) {
      return res.status(400).json({ success: false, message: 'Invalid actor role' })
    }

    const candidateFilter: Record<string, any> = {
      $or: [
        { entity: 'Lead', action: { $in: [...LEAD_TRANSFER_ACTIONS] } },
        {
          entity: 'QueueItem',
          action: 'queue.assigned',
          'metadata.leadTransferRecorded': { $ne: true },
        },
      ],
    }

    // Legacy bulk updates share an action with ordinary field edits. Compare
    // owner IDs (falling back to legacy owner names) inside Mongo so only real
    // ownership changes are counted and paginated.
    const ownerIdentity = (side: 'before' | 'after') => ({
      $ifNull: [
        side === 'after'
          ? { $ifNull: ['$after.owner', '$after.assignedTo'] }
          : '$before.owner',
        {
          $cond: [
            {
              $gt: [
                {
                  $strLenCP: {
                    $ifNull: [
                      side === 'after'
                        ? { $ifNull: ['$after.ownerName', '$after.assignedToName'] }
                        : '$before.ownerName',
                      '',
                    ],
                  },
                },
                0,
              ],
            },
            {
              $concat: [
                'name:',
                {
                  $toLower:
                    side === 'after'
                      ? { $ifNull: ['$after.ownerName', '$after.assignedToName'] }
                      : '$before.ownerName',
                },
              ],
            },
            null,
          ],
        },
      ],
    })
    const fromIdentity = ownerIdentity('before')
    const toIdentity = ownerIdentity('after')
    const ownershipChanged = { $ne: [fromIdentity, toIdentity] }

    if (type === 'assignment') {
      candidateFilter.$expr = {
        $and: [{ $eq: [fromIdentity, null] }, { $ne: [toIdentity, null] }],
      }
    } else if (type === 'transfer') {
      candidateFilter.$expr = {
        $and: [
          { $ne: [fromIdentity, null] },
          { $ne: [toIdentity, null] },
          ownershipChanged,
        ],
      }
    } else if (type === 'unassignment') {
      candidateFilter.$expr = {
        $and: [{ $ne: [fromIdentity, null] }, { $eq: [toIdentity, null] }],
      }
    } else {
      candidateFilter.$expr = ownershipChanged
    }

    if (actorRole) candidateFilter.actorRole = actorRole
    if (dateFrom || dateTo) {
      const createdAt: Record<string, Date> = {}
      let parsedFrom: Date | null = null
      let parsedTo: Date | null = null
      if (dateFrom) {
        parsedFrom = new Date(dateFrom)
        if (isNaN(parsedFrom.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid from date' })
        }
        parsedFrom.setHours(0, 0, 0, 0)
        createdAt.$gte = parsedFrom
      }
      if (dateTo) {
        parsedTo = new Date(dateTo)
        if (isNaN(parsedTo.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid to date' })
        }
        parsedTo.setHours(23, 59, 59, 999)
        createdAt.$lte = parsedTo
      }
      if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
        return res.status(400).json({ success: false, message: 'From date must be on or before to date' })
      }
      candidateFilter.createdAt = createdAt
    }

    if (search?.trim()) {
      const safeSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = { $regex: safeSearch, $options: 'i' }
      candidateFilter.$or = [
        { actorName: match },
        { 'before.name': match },
        { 'after.name': match },
        { 'before.phone': match },
        { 'after.phone': match },
        { 'after.leadName': match },
        { 'before.ownerName': match },
        { 'after.ownerName': match },
        { 'after.assignedToName': match },
      ]
    }

    const start = (pageNum - 1) * limitNum
    const [logs, total] = await Promise.all([
      AuditLog.find(candidateFilter)
        .sort({ createdAt: -1 })
        .skip(start)
        .limit(limitNum)
        .lean(),
      AuditLog.countDocuments(candidateFilter),
    ])
    const data = logs
      .map((log) => normalizeLeadTransferLog(log))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getAuditLogById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const log = await AuditLog.findById(req.params.id)
    if (!log) {
      return res.status(404).json({ success: false, message: 'Audit log not found' })
    }
    return res.status(200).json({ success: true, data: log })
  } catch (err) {
    next(err)
  }
}

export const getAuditLogsByEntity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entity, entityId } = req.params
    const logs = await AuditLog.find({ entity, entityId }).sort({ createdAt: -1 }).limit(100)
    return res.status(200).json({ success: true, data: logs })
  } catch (err) {
    next(err)
  }
}
