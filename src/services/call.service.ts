import { Call } from '../models/Call'
import { Lead } from '../models/Lead'
import { initiateOutboundCall } from './exotel.service'
import { logger } from '../utils/logger'

export const startCall = async (
  leadId: string,
  phone: string,
  repId: string,
  repName: string
) => {
  const lead = await Lead.findById(leadId)
  if (!lead) throw new Error('Lead not found')

  const exotelCall = await initiateOutboundCall(phone, String(lead._id))

  const call = await Call.create({
    lead: leadId,
    leadName: lead.name,
    phone,
    representative: repId,
    representativeName: repName,
    exotelCallSid: exotelCall?.Sid || null,
    status: exotelCall ? 'initiated' : 'failed',
    startedAt: new Date(),
  })

  await Lead.findByIdAndUpdate(leadId, { lastActivity: new Date() })

  return call
}

export const applyCallFeedback = async (
  callId: string,
  repId: string,
  data: {
    outcome: string
    notes?: string
    interested?: boolean
    callBackAt?: string
    reason?: string
    stage?: string
  }
) => {
  const call = await Call.findById(callId)
  if (!call) return null
  if (String(call.representative) !== repId) throw new Error('Unauthorized')

  call.outcome = data.outcome
  call.notes = data.notes || null
  call.stage = data.stage || null
  call.feedback = {
    interested: data.interested,
    callBackAt: data.callBackAt ? new Date(data.callBackAt) : null,
    reason: data.reason || null,
  }
  await call.save()

  await Lead.findByIdAndUpdate(call.lead, {
    lastActivity: new Date(),
    lastActivityNote: data.notes || null,
    ...(data.stage && { disposition: data.stage }),
  })

  return call
}
