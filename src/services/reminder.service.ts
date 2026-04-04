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
  const pending = await Reminder.find({ status: { $in: ['upcoming', 'due_soon', 'overdue'] } })
  let updated = 0

  for (const reminder of pending) {
    const newStatus = computeReminderStatus(reminder.dueAt)
    if (newStatus !== reminder.status) {
      reminder.status = newStatus
      await reminder.save()
      updated++
    }
  }

  return updated
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
