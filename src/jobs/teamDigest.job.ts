import { User } from '../models/User'
import { Call } from '../models/Call'
import { Lead } from '../models/Lead'
import { Reminder } from '../models/Reminder'
import { sendTeamDigestEmail } from '../services/ses.service'
import { Settings } from '../models/Settings'
import { logger } from '../utils/logger'
import { normalizeNotificationPrefs } from '../utils/notificationPrefs'

let intervalId: NodeJS.Timeout | null = null

const sendDigests = async () => {
  try {
    const settings = await Settings.findOne()
    const digestTime = settings?.notifications?.dailyDigestTime || '08:00'
    const [hour, minute] = digestTime.split(':').map(Number)
    const now = new Date()
    if (now.getHours() !== hour || now.getMinutes() > minute + 5) return

    const recipients = await User.find({ isActive: true }).select('name email role notificationPrefs')
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    for (const recipient of recipients) {
      if (!normalizeNotificationPrefs(recipient.notificationPrefs).dailyDigest) {
        continue
      }

      const repId = String(recipient._id)

      const [callsToday, connectedCalls, overdueReminders, newLeads] = await Promise.all([
        Call.countDocuments({ representative: repId, startedAt: { $gte: todayStart } }),
        Call.countDocuments({ representative: repId, startedAt: { $gte: todayStart }, outcome: 'Connected' }),
        Reminder.countDocuments({ owner: repId, status: 'overdue' }),
        Lead.countDocuments({ owner: repId, createdAt: { $gte: todayStart } }),
      ])

      await sendTeamDigestEmail(recipient.email, recipient.name, {
        callsToday,
        connectedCalls,
        overdueReminders,
        newLeads,
      })
    }

    logger.info('Daily digests sent', { count: recipients.length })
  } catch (err) {
    logger.error('teamDigest job error', err)
  }
}

export const startTeamDigest = () => {
  if (intervalId) return
  intervalId = setInterval(sendDigests, 5 * 60 * 1000)
  logger.info('teamDigest job started (every 5m check)')
}

export const stopTeamDigest = () => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('teamDigest job stopped')
  }
}
