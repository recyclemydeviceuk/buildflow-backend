import { NextFunction, Request, Response } from 'express'
import { Call } from '../models/Call'
import { SmsMessage } from '../models/SmsMessage'
import { exotelConfig } from '../config/exotel'
import { emitToTeam } from '../config/socket'
import { sendSMS } from '../services/exotel.service'

const normalizePhoneForSms = (value?: string | null): string => {
  if (!value) return ''

  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''

  if (trimmed.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`
  return `+${digits}`
}

const normalizeSmsFrom = (value?: string | null): string => {
  if (!value) return ''

  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return trimmed.toUpperCase()

  if (trimmed.startsWith('+')) {
    if (digits.length === 12 && digits.startsWith('91')) {
      return digits.slice(2)
    }
    return digits
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2)
  }

  if (digits.length === 10) {
    return digits
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1)
  }

  return digits
}

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

const emitSmsEvent = (eventName: 'sms:new' | 'sms:status_updated', message: any) => {
  emitToTeam('all', eventName, serializeSms(message))
}

const getCallForSms = async (req: Request) => {
  const call = await Call.findById(req.params.id).exec()
  if (!call) return null
  if (req.user!.role === 'representative' && String(call.representative) !== req.user!.id) {
    return 'forbidden' as const
  }
  return call
}

export const listMessagesForCall = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await getCallForSms(req)
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' })
    }
    if (call === 'forbidden') {
      return res.status(403).json({ success: false, message: 'You do not have access to this call' })
    }

    const messages = await SmsMessage.find({ lead: call.lead }).sort({ createdAt: -1 }).lean()
    return res.status(200).json({ success: true, data: messages.map(serializeSms) })
  } catch (err) {
    next(err)
  }
}

export const sendMessageForCall = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await getCallForSms(req)
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' })
    }
    if (call === 'forbidden') {
      return res.status(403).json({ success: false, message: 'You do not have access to this call' })
    }

    const body = String(req.body.body || '').trim()
    if (!body) {
      return res.status(400).json({ success: false, message: 'SMS body is required' })
    }

    const to = normalizePhoneForSms(call.phone)
    if (!to) {
      return res.status(400).json({ success: false, message: 'Lead phone number is not valid for SMS' })
    }

    const from = normalizeSmsFrom(exotelConfig.smsFrom || call.exophoneNumber || exotelConfig.exoPhone)
    const customField = JSON.stringify({
      source: 'buildflow',
      smsLeadId: String(call.lead),
      smsCallId: String(call._id),
      sentBy: req.user!.id,
    })

    const result = await sendSMS({
      to,
      body,
      from,
      customField,
      statusCallback: exotelConfig.smsStatusCallbackUrl,
    })

    const message = await SmsMessage.create({
      lead: call.lead,
      call: call._id,
      phone: call.phone,
      from,
      to,
      body,
      direction: 'outbound',
      provider: 'Exotel',
      providerMessageSid: result.sid || null,
      status: result.success ? ((result.status as any) || 'submitted') : 'failed',
      detailedStatus: result.detailedStatus || null,
      detailedStatusCode: result.detailedStatusCode || null,
      customField,
      createdBy: req.user!.id,
      createdByName: req.user!.name,
    })

    emitSmsEvent('sms:new', message)

    const statusCode = result.success ? 201 : 502
    return res.status(statusCode).json({
      success: result.success,
      data: serializeSms(message),
      message: result.success ? 'SMS queued with Exotel' : result.detailedStatus || 'SMS could not be sent',
    })
  } catch (err) {
    next(err)
  }
}
