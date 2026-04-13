import { Request, Response, NextFunction } from 'express'
import { QueueItem } from '../models/QueueItem'
import { Lead } from '../models/Lead'
import { AuditLog } from '../models/AuditLog'

export const getQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { segment, page = '1', limit = '50' } = req.query as Record<string, string>

    const filter: Record<string, unknown> = { status: { $ne: 'resolved' } }
    if (segment) filter.segment = segment

    const pageNum = Math.max(1, parseInt(page))
    const limitNum = Math.min(100, parseInt(limit))
    const skip = (pageNum - 1) * limitNum

    const [items, total] = await Promise.all([
      QueueItem.find(filter).sort({ urgency: -1, createdAt: 1 }).skip(skip).limit(limitNum),
      QueueItem.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

export const getLiveQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await QueueItem.find({
      segment: 'Unassigned',
      status: 'waiting',
    }).sort({ createdAt: 1 }).limit(20)

    return res.status(200).json({ success: true, data: items })
  } catch (err) {
    next(err)
  }
}

export const assignQueueItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { assignedTo, assignedName } = req.body

    const item = await QueueItem.findById(req.params.id)
    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    item.assignedTo = assignedTo
    item.assignedToName = assignedName
    item.status = 'assigned'
    item.assignedAt = new Date()
    item.segment = 'Unassigned'
    await item.save()

    await Lead.findByIdAndUpdate(item.leadId, {
      owner: assignedTo,
      assignedAt: new Date(),
    })

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'queue.assigned',
      entity: 'QueueItem',
      entityId: String(item._id),
      after: item.toObject(),
    })

    return res.status(200).json({ success: true, data: item })
  } catch (err) {
    next(err)
  }
}

export const requeueItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await QueueItem.findByIdAndUpdate(
      req.params.id,
      {
        status: 'waiting',
        segment: 'Unassigned',
        assignedTo: null,
        assignedAt: null,
        requeuedAt: new Date(),
      },
      { new: true }
    )

    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'queue.requeued',
      entity: 'QueueItem',
      entityId: req.params.id,
    })

    return res.status(200).json({ success: true, data: item })
  } catch (err) {
    next(err)
  }
}

export const holdQueueItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await QueueItem.findByIdAndUpdate(
      req.params.id,
      { status: 'on_hold', heldAt: new Date() },
      { new: true }
    )

    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    return res.status(200).json({ success: true, data: item })
  } catch (err) {
    next(err)
  }
}

export const markInvalid = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body

    const item = await QueueItem.findByIdAndUpdate(
      req.params.id,
      { status: 'invalid', invalidReason: reason, resolvedAt: new Date() },
      { new: true }
    )

    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    await Lead.findByIdAndUpdate(item.leadId, { disposition: 'Failed' })

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'queue.marked_invalid',
      entity: 'QueueItem',
      entityId: req.params.id,
    })

    return res.status(200).json({ success: true, data: item })
  } catch (err) {
    next(err)
  }
}

export const skipQueueItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await QueueItem.findById(req.params.id)
    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    item.skipCount = (item.skipCount || 0) + 1
    item.lastSkippedBy = req.user!.id as any
    item.lastSkippedAt = new Date()

    if (item.skipCount >= 3) {
      item.segment = 'Escalated'
      item.status = 'escalated'
    } else {
      item.segment = 'Skipped'
      item.status = 'waiting'
    }

    await item.save()

    return res.status(200).json({ success: true, data: item })
  } catch (err) {
    next(err)
  }
}
