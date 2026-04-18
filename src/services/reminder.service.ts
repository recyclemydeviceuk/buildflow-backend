import { Reminder } from '../models/Reminder'
import { User } from '../models/User'
import { sendReminderEmail } from './ses.service'
import { isOverdue, isDueSoon } from '../utils/dateHelpers'
import { logger } from '../utils/logger'
import { normalizeNotificationPrefs } from '../utils/notificationPrefs'

export const computeReminderStatus = (dueAt: Date): 'upcoming' | 'due_soon' | 'overdue' => {
  if (isOverdue(dueAt)) return 'overdue'
  if (isDueSoon(dueAt, 30)) return 'due_soon'
  return 'upcoming'
}

export const refreshReminderStatuses = async (): Promise<number> => {
  // Fetch only what we need (id, status, dueAt) and compute the delta in memory,
  // then flush all updates in a single bulkWrite. Previously this function did
  // N serial save() calls which made every GET /reminders scale linearly with
  // the number of pending reminders — catastrophic once counts grow.
  const pending = await Reminder.find(
    { status: { $in: ['upcoming', 'due_soon', 'overdue'] } },
    { status: 1, dueAt: 1 }
  ).lean()

  const ops: any[] = []
  for (const reminder of pending) {
    const newStatus = computeReminderStatus(reminder.dueAt as Date)
    if (newStatus !== reminder.status) {
      ops.push({
        updateOne: {
          filter: { _id: reminder._id },
          update: { $set: { status: newStatus } },
        },
      })
    }
  }

  if (ops.length === 0) return 0
  await Reminder.bulkWrite(ops, { ordered: false })
  return ops.length
}

export const sendDueSoonNotifications = async (): Promise<void> => {
  try {
    const dueSoon = await Reminder.find({ status: { $in: ['due_soon', 'overdue'] } })
      .populate<{ owner: { email: string; name: string; notificationPrefs?: any } }>(
        'owner',
        'email name notificationPrefs'
      )

    for (const reminder of dueSoon) {
      if (!reminder.owner || !('email' in reminder.owner)) continue
      if (reminder.lastEmailNotificationStatus === reminder.status) continue
      if (!normalizeNotificationPrefs(reminder.owner.notificationPrefs).reminderAlerts) continue

      const sent = await sendReminderEmail(
        reminder.owner.email,
        reminder.owner.name,
        reminder.title,
        reminder.dueAt
      )

      if (sent) {
        reminder.lastEmailNotificationStatus = reminder.status === 'overdue' ? 'overdue' : 'due_soon'
        reminder.lastEmailNotificationAt = new Date()
        await reminder.save()
      }
    }
  } catch (err) {
    logger.error('sendDueSoonNotifications error', err)
  }
}
