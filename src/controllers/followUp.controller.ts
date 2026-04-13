import { Request, Response, NextFunction } from 'express'
import mongoose from 'mongoose'
import { FollowUp } from '../models/FollowUp'

const FOLLOW_UP_POPUP_WINDOW_MS = 30 * 60 * 1000
const FOLLOW_UP_POPUP_REPEAT_MS = 5 * 60 * 1000

const canAccessFollowUp = (req: Request, followUp: any) => {
  if (req.user!.role === 'manager') return true
  return String(followUp.owner) === String(req.user!.id)
}

const getNotificationStateForUser = (followUp: any, userId: string) =>
  (followUp.notificationStates || []).find((entry: any) => String(entry.user) === String(userId)) || null

const serializeFollowUp = (followUp: any, userId?: string) => {
  const rawFollowUp = typeof followUp.toObject === 'function' ? followUp.toObject() : followUp
  const notificationState = userId ? getNotificationStateForUser(rawFollowUp, userId) : null

  return {
    ...rawFollowUp,
    notificationState: notificationState
      ? {
          confirmedAt: notificationState.confirmedAt || null,
          lastPromptAt: notificationState.lastPromptAt || null,
        }
      : null,
  }
}

const upsertNotificationState = (
  followUp: any,
  userId: string,
  patch: { confirmedAt?: Date | null; lastPromptAt?: Date | null }
) => {
  const existingState = (followUp.notificationStates || []).find(
    (entry: any) => String(entry.user) === String(userId)
  )

  if (existingState) {
    if (patch.confirmedAt !== undefined) existingState.confirmedAt = patch.confirmedAt
    if (patch.lastPromptAt !== undefined) existingState.lastPromptAt = patch.lastPromptAt
    return
  }

  followUp.notificationStates = [
    ...(followUp.notificationStates || []),
    {
      user: new mongoose.Types.ObjectId(userId),
      confirmedAt: patch.confirmedAt ?? null,
      lastPromptAt: patch.lastPromptAt ?? null,
    },
  ]
}

const isEligibleForPopup = (followUp: any, userId: string, now: Date) => {
  if (followUp.status !== 'pending') return false

  const scheduledAt = new Date(followUp.scheduledAt)
  if (scheduledAt.getTime() <= now.getTime()) return false

  const timeUntilFollowUp = scheduledAt.getTime() - now.getTime()
  if (timeUntilFollowUp > FOLLOW_UP_POPUP_WINDOW_MS) return false

  const notificationState = getNotificationStateForUser(followUp, userId)
  if (notificationState?.confirmedAt) return false

  if (notificationState?.lastPromptAt) {
    const timeSinceLastPrompt = now.getTime() - new Date(notificationState.lastPromptAt).getTime()
    if (timeSinceLastPrompt < FOLLOW_UP_POPUP_REPEAT_MS) return false
  }

  return true
}

export const getFollowUps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { owner, page = '1', limit = '100', search, status } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}

    if (req.user!.role === 'representative') {
      filter.owner = req.user!.id
    } else if (owner && mongoose.Types.ObjectId.isValid(owner)) {
      filter.owner = owner
    }

    if (status) {
      filter.status = status
    }

    if (search) {
      filter.$or = [
        { leadName: { $regex: search, $options: 'i' } },
        { ownerName: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } },
      ]
    }

    const pageNum = Math.max(1, parseInt(page))
    const limitNum = Math.min(200, parseInt(limit))
    const skip = (pageNum - 1) * limitNum

    const [followUps, total] = await Promise.all([
      FollowUp.find(filter).sort({ scheduledAt: 1 }).skip(skip).limit(limitNum),
      FollowUp.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: followUps.map((followUp) => serializeFollowUp(followUp, req.user!.id)),
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

export const getNextFollowUpPopup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role === 'manager') {
      return res.status(200).json({ success: true, data: null })
    }

    const baseFilter: Record<string, unknown> = { status: 'pending' }

    baseFilter.owner = req.user!.id

    const now = new Date()
    const candidates = await FollowUp.find(baseFilter).sort({ scheduledAt: 1 }).limit(100)
    const nextFollowUp = candidates.find((followUp) => isEligibleForPopup(followUp, req.user!.id, now))

    if (!nextFollowUp) {
      return res.status(200).json({ success: true, data: null })
    }

    upsertNotificationState(nextFollowUp, req.user!.id, { lastPromptAt: now })
    await nextFollowUp.save()

    return res.status(200).json({
      success: true,
      data: serializeFollowUp(nextFollowUp, req.user!.id),
    })
  } catch (err) {
    next(err)
  }
}

export const confirmFollowUpPopup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followUp = await FollowUp.findById(req.params.id)
    if (!followUp) {
      return res.status(404).json({ success: false, message: 'Follow-up not found' })
    }

    if (!canAccessFollowUp(req, followUp)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this follow-up' })
    }

    upsertNotificationState(followUp, req.user!.id, {
      confirmedAt: new Date(),
      lastPromptAt: new Date(),
    })
    await followUp.save()

    return res.status(200).json({
      success: true,
      data: serializeFollowUp(followUp, req.user!.id),
    })
  } catch (err) {
    next(err)
  }
}

export const skipFollowUpPopup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followUp = await FollowUp.findById(req.params.id)
    if (!followUp) {
      return res.status(404).json({ success: false, message: 'Follow-up not found' })
    }

    if (!canAccessFollowUp(req, followUp)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this follow-up' })
    }

    upsertNotificationState(followUp, req.user!.id, { lastPromptAt: new Date() })
    await followUp.save()

    return res.status(200).json({
      success: true,
      data: serializeFollowUp(followUp, req.user!.id),
    })
  } catch (err) {
    next(err)
  }
}
