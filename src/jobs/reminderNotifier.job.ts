import { Reminder } from '../models/Reminder'
import { User } from '../models/User'
import { computeReminderStatus, sendDueSoonNotifications } from '../services/reminder.service'
import { emitToUser } from '../config/socket'
import { logger } from '../utils/logger'

let intervalId: NodeJS.Timeout | null = null

const runReminderCheck = async () => {
  try {
    const pending = await Reminder.find({ status: { $in: ['upcoming', 'due_soon'] } })

    for (const reminder of pending) {
      const newStatus = computeReminderStatus(reminder.dueAt)
      if (newStatus !== reminder.status) {
        reminder.status = newStatus
        await reminder.save()

        if (newStatus === 'due_soon' || newStatus === 'overdue') {
          emitToUser(String(reminder.owner), 'reminder:due', {
            reminderId: reminder._id,
            title: reminder.title,
            leadId: reminder.lead,
            status: newStatus,
          })
        }
      }
    }

    await sendDueSoonNotifications()
  } catch (err) {
    logger.error('reminderNotifier job error', err)
  }
}

export const startReminderNotifier = () => {
  if (intervalId) return
  intervalId = setInterval(runReminderCheck, 60 * 1000)
  logger.info('reminderNotifier job started (every 60s)')
  runReminderCheck()
}

export const stopReminderNotifier = () => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('reminderNotifier job stopped')
  }
}
