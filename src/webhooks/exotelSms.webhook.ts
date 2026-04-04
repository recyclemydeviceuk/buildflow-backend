import { SmsMessage } from '../models/SmsMessage'
import { emitToTeam } from '../config/socket'
import { ExotelSMSStatusCallbackPayload } from '../types/exotel.types'

const serializeSms = (message: any) => ({
  _id: String(message._id),
  lead: message.lead,
  call: message.call,
  phone: message.phone,
  from: message.from,
  to: message.to,
  body: message.body,
  direction: message.direction,
  provider: message.provider,
  providerMessageSid: message.providerMessageSid || null,
  status: message.status,
  detailedStatus: message.detailedStatus || null,
  detailedStatusCode: message.detailedStatusCode || null,
  customField: message.customField || null,
  createdBy: message.createdBy,
  createdByName: message.createdByName,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
})

export const processExotelSmsStatus = async (payload: ExotelSMSStatusCallbackPayload) => {
  const smsSid = payload.SmsSid
  if (!smsSid) return

  const message = await SmsMessage.findOne({ providerMessageSid: smsSid }).exec()
  if (!message) return

  let changed = false

  if (payload.Status && message.status !== payload.Status) {
    message.status = payload.Status as any
    changed = true
  }

  if ((message.detailedStatus || null) !== (payload.DetailedStatus || null)) {
    message.detailedStatus = payload.DetailedStatus || null
    changed = true
  }

  if ((message.detailedStatusCode || null) !== (payload.DetailedStatusCode || null)) {
    message.detailedStatusCode = payload.DetailedStatusCode || null
    changed = true
  }

  if (!changed) return

  await message.save()
  emitToTeam('all', 'sms:status_updated', serializeSms(message))
}
