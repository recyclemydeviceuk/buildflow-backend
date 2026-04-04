import { Request, Response, NextFunction } from 'express'
import { AuditLog } from '../models/AuditLog'

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
