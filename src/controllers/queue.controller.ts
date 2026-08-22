import { Request, Response, NextFunction } from 'express'
import { QueueItem } from '../models/QueueItem'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { AuditLog } from '../models/AuditLog'
import { getLeadOwnershipAction } from '../utils/leadTransferHistory'
import { findEligibleRep } from '../services/leadRouting.service'
import { notifyLeadAssigned } from '../services/socket.service'

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
    // The validator on this route accepts `userId` (the new name) but the
    // legacy frontend still sometimes sends `assignedTo` — accept both.
    const assignedTo = req.body.userId || req.body.assignedTo
    if (!assignedTo) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }

    const item = await QueueItem.findById(req.params.id)
    if (!item) {
      return res.status(404).json({ success: false, message: 'Queue item not found' })
    }

    // Eligibility check — same rule the other assignment paths enforce. The
    // old implementation blindly trusted the body, which meant the queue UI
    // could route a lead to a rep whose account was deactivated or whose
    // lead-receiving switch had been turned off. (Issue: "leads are getting
    // assigned automatically even after the rep account is turned off".)
    const rep = await findEligibleRep(assignedTo)
    if (!rep) {
      const exists = await User.exists({ _id: assignedTo, role: 'representative' })
      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? 'That representative is not currently accepting new leads (account inactive or lead-receiving switch is off).'
          : 'Representative not found',
      })
    }

    item.assignedTo = rep._id as any
    item.assignedToName = rep.name
    item.status = 'assigned'
    item.assignedAt = new Date()
    item.segment = 'Unassigned'
    await item.save()

    const leadBefore = await Lead.findById(item.leadId)
    const lead = await Lead.findByIdAndUpdate(
      item.leadId,
      {
        owner: rep._id,
        ownerName: rep.name,
        assignedAt: new Date(),
        assignmentAcknowledged: false,
      },
      { new: true }
    )

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'queue.assigned',
      entity: 'QueueItem',
      entityId: String(item._id),
      after: item.toObject(),
      metadata: { leadTransferRecorded: Boolean(lead) },
    })

    if (lead) {
      const beforeObject = leadBefore?.toObject() || {}
      const afterObject = lead.toObject()
      await AuditLog.create({
        actor: req.user!.id,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        action: getLeadOwnershipAction(beforeObject, afterObject) || 'lead.assigned',
        entity: 'Lead',
        entityId: String(lead._id),
        before: beforeObject,
        after: afterObject,
        metadata: { transferSource: 'queue' },
      })
    }

    // Same socket fan-out as direct assignment so the receiving rep's lists
    // refresh in real-time and the popup fires.
    if (lead) {
      notifyLeadAssigned(String(lead._id), String(rep._id), rep.name, {
        leadName: lead.name,
        phone: lead.phone,
        city: lead.city,
        source: lead.source,
      })
    }

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
