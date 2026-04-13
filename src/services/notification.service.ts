import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { Call } from '../models/Call'
import { sendMissedCallAlertEmail, sendNewLeadAlertEmail } from './ses.service'
import { normalizeNotificationPrefs, type NotificationPreferences } from '../utils/notificationPrefs'
import { logger } from '../utils/logger'

type NotificationPrefKey = keyof NotificationPreferences

const getOptedInUsers = async (
  filter: Record<string, unknown>,
  preferenceKey: NotificationPrefKey
) => {
  const users = await User.find({ ...filter, isActive: true }).select('name email notificationPrefs')

  return users.filter((user) => normalizeNotificationPrefs(user.notificationPrefs)[preferenceKey])
}

const uniqueUsersById = <T extends { _id: any }>(users: T[]) => {
  const seen = new Set<string>()
  return users.filter((user) => {
    const id = String(user._id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export const notifyNewLeadCreated = async (lead: {
  _id: any
  name: string
  phone: string
  city?: string | null
  source: string
  owner?: any
}): Promise<void> => {
  try {
    const [managers, owner] = await Promise.all([
      getOptedInUsers({ role: 'manager' }, 'newLeadAlerts'),
      lead.owner ? User.findById(lead.owner).select('name email notificationPrefs isActive') : Promise.resolve(null),
    ])

    const ownerRecipients =
      owner && owner.isActive && normalizeNotificationPrefs(owner.notificationPrefs).newLeadAlerts ? [owner] : []

    const recipients = uniqueUsersById([...managers, ...ownerRecipients])

    await Promise.all(
      recipients.map((recipient) =>
        sendNewLeadAlertEmail(recipient.email, recipient.name, {
          leadId: String(lead._id),
          name: lead.name,
          phone: lead.phone,
          city: lead.city || 'Unknown',
          source: lead.source,
        })
      )
    )
  } catch (err) {
    logger.error('notifyNewLeadCreated error', err)
  }
}

export const notifyMissedCall = async (callId: string): Promise<void> => {
  try {
    const call = await Call.findById(callId).select(
      'lead leadName phone outcome direction startedAt createdAt exophoneNumber representative representativeName missedCallAlertSentAt'
    )

    if (!call) return
    if (call.missedCallAlertSentAt) return

    const outcome = call.outcome || ''
    if (!['Not Answered', 'Busy'].includes(outcome)) return

    const [lead, managers, representative] = await Promise.all([
      call.lead ? Lead.findById(call.lead).select('_id') : Promise.resolve(null),
      getOptedInUsers({ role: 'manager' }, 'missedCallAlerts'),
      call.representative ? User.findById(call.representative).select('name email notificationPrefs isActive') : Promise.resolve(null),
    ])

    const repRecipients =
      representative &&
      representative.isActive &&
      normalizeNotificationPrefs(representative.notificationPrefs).missedCallAlerts
        ? [representative]
        : []

    const recipients = uniqueUsersById([...managers, ...repRecipients])

    await Promise.all(
      recipients.map((recipient) =>
        sendMissedCallAlertEmail(recipient.email, recipient.name, {
          leadId: lead ? String(lead._id) : null,
          leadName: call.leadName,
          phone: call.phone,
          callDirection: call.direction || 'Unknown',
          outcome,
          callAt: call.startedAt || call.createdAt,
          exophoneNumber: call.exophoneNumber || null,
        })
      )
    )

    call.missedCallAlertSentAt = new Date()
    await call.save()
  } catch (err) {
    logger.error('notifyMissedCall error', err)
  }
}
