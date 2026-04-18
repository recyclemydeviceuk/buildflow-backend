import { Request, Response, NextFunction } from 'express'
import { Reminder } from '../models/Reminder'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { computeReminderStatus, refreshReminderStatuses } from '../services/reminder.service'

const canAccessLeadReminder = (req: Request, lead: any) => {
  if (req.user!.role === 'manager') return true
  return Boolean(lead.owner && String(lead.owner) === String(req.user!.id))
}

const canAccessReminder = (req: Request, reminder: any) => {
  if (req.user!.role === 'manager') return true
  return String(reminder.owner) === String(req.user!.id)
}

const syncLeadNextFollowUp = async (leadId: string) => {
  const nextReminder = await Reminder.findOne({
    lead: leadId,
    status: { $ne: 'completed' },
  }).sort({ dueAt: 1 })

  await Lead.findByIdAndUpdate(leadId, {
    nextFollowUp: nextReminder?.dueAt || null,
  })
}

export const getReminders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Don't block the response on status refresh — run it in the background.
    // The serializer below computes the live status from dueAt on the fly anyway.
    void refreshReminderStatuses().catch(() => null)
    const { status, leadId, page = '1', limit = '50' } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}

    if (req.user!.role === 'representative') filter.owner = req.user!.id
    if (status) filter.status = status
    if (leadId) filter.lead = leadId

    const pageNum = Math.max(1, parseInt(page))
    const limitNum = Math.min(100, parseInt(limit))
    const skip = (pageNum - 1) * limitNum

    const [reminders, total] = await Promise.all([
      Reminder.find(filter).sort({ dueAt: 1 }).skip(skip).limit(limitNum),
      Reminder.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: reminders,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

export const getReminderById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    void refreshReminderStatuses().catch(() => null)
    const reminder = await Reminder.findById(req.params.id)
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }
    if (!canAccessReminder(req, reminder)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this reminder' })
    }
    return res.status(200).json({ success: true, data: reminder })
  } catch (err) {
    next(err)
  }
}

export const createReminder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leadId, title, dueAt, notes, priority, owner } = req.body
    const lead = await Lead.findById(leadId)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLeadReminder(req, lead)) {
      return res.status(403).json({ success: false, message: 'You do not have access to create reminders for this lead' })
    }

    const ownerId = owner || lead.owner || req.user!.id
    const ownerUser = await User.findById(ownerId).select('name')
    if (!ownerUser) {
      return res.status(404).json({ success: false, message: 'Reminder owner not found' })
    }

    const reminder = await Reminder.create({
      lead: lead._id,
      leadName: lead.name,
      owner: ownerUser._id,
      ownerName: ownerUser.name,
      title,
      dueAt,
      notes: notes || null,
      priority: priority || 'medium',
      status: computeReminderStatus(new Date(dueAt)),
      lastEmailNotificationStatus: null,
      lastEmailNotificationAt: null,
    })

    await syncLeadNextFollowUp(String(lead._id))
    return res.status(201).json({ success: true, data: reminder })
  } catch (err) {
    next(err)
  }
}

export const updateReminder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await Reminder.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }
    if (!canAccessReminder(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this reminder' })
    }

    const payload = {
      ...req.body,
      ...(req.body.dueAt ? { status: computeReminderStatus(new Date(req.body.dueAt)) } : {}),
      ...(req.body.dueAt ? { lastEmailNotificationStatus: null, lastEmailNotificationAt: null } : {}),
    }

    const reminder = await Reminder.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    })
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }

    await syncLeadNextFollowUp(String(reminder.lead))
    return res.status(200).json({ success: true, data: reminder })
  } catch (err) {
    next(err)
  }
}

export const deleteReminder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await Reminder.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }
    if (!canAccessReminder(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to delete this reminder' })
    }

    const reminder = await Reminder.findByIdAndDelete(req.params.id)
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }

    await syncLeadNextFollowUp(String(reminder.lead))
    return res.status(200).json({ success: true, message: 'Reminder deleted' })
  } catch (err) {
    next(err)
  }
}

export const markReminderDone = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await Reminder.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }
    if (!canAccessReminder(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this reminder' })
    }

    const reminder = await Reminder.findByIdAndUpdate(
      req.params.id,
      {
        status: 'completed',
        completedAt: new Date(),
        lastEmailNotificationStatus: null,
        lastEmailNotificationAt: null,
      },
      { new: true }
    )
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found' })
    }

    await syncLeadNextFollowUp(String(reminder.lead))
    return res.status(200).json({ success: true, data: reminder })
  } catch (err) {
    next(err)
  }
}

export const getOverdueReminders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await refreshReminderStatuses()
    const filter: Record<string, unknown> = {
      dueAt: { $lt: new Date() },
      status: { $in: ['upcoming', 'due_soon'] },
    }

    if (req.user!.role === 'representative') filter.owner = req.user!.id

    const reminders = await Reminder.find(filter).sort({ dueAt: 1 })
    return res.status(200).json({ success: true, data: reminders })
  } catch (err) {
    next(err)
  }
}
