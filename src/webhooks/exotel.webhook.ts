import { Call } from '../models/Call'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { DeletedLeadPhone } from '../models/DeletedLeadPhone'
import { emitToTeam, emitUserAvailabilityUpdate } from '../config/socket'
import { ExotelCallStatusPayload, ExotelV3StatusCallbackPayload } from '../types/exotel.types'
import { uploadFromUrl } from '../services/s3.service'
import { triggerExoVoiceAnalyze } from '../services/exotel.service'
import { syncExotelCallHistory } from '../services/callSync.service'
import { S3_RECORDINGS_PREFIX } from '../config/constants'
import { logger } from '../utils/logger'
import { notifyMissedCall, notifyNewLeadCreated } from '../services/notification.service'

const parseIstDate = (value?: string | null): Date | null => {
  if (!value) return null
  const hasTimezone = value.includes('Z') || value.includes('+') || (value.includes('-') && value.lastIndexOf('-') > 7)
  if (hasTimezone) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const d = new Date(normalized + '+05:30')
  return Number.isNaN(d.getTime()) ? null : d
}

const normalizePhone = (value?: string | null): string => {
  if (!value) return ''
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''
  const stripped = digits.replace(/^0+/, '')
  return stripped.length <= 10 ? stripped : stripped.slice(-10)
}

const buildExotelLeadName = (phone: string): string => {
  const normalizedPhone = normalizePhone(phone)
  return normalizedPhone ? `Direct ${normalizedPhone.slice(-4)}` : 'Direct Lead'
}

const buildExotelLeadNote = (payload: ExotelCallStatusPayload): string => {
  const parts = [
    `Exotel ${['incoming', 'inbound'].includes(payload.Direction?.toLowerCase() || '') ? 'incoming' : 'outgoing'} call`,
    payload.Status ? `status ${payload.Status}` : null,
    payload.CallSid ? `sid ${payload.CallSid}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
}

const buildManagedLeadNote = (callSid: string, status?: string | null): string => {
  return [
    'Exotel incoming call',
    status ? `status ${status}` : null,
    callSid ? `sid ${callSid}` : null,
  ]
    .filter(Boolean)
    .join(' | ')
}

const emitIncomingLeadEvent = (lead: any) => {
  emitToTeam('all', 'lead:incoming', {
    lead: {
      id: lead._id,
      _id: lead._id,
      name: lead.name,
      phone: lead.phone,
      city: lead.city,
      source: lead.source,
      owner: lead.owner || null,
    },
  })
}

const readManagedPhoneCandidate = (value: any): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return ''

  return String(
    value.contact_uri ||
      value.contactUri ||
      value.phone ||
      value.phone_number ||
      value.number ||
      value.value ||
      ''
  ).trim()
}

const extractManagedLeadPhone = (
  callDetails: ExotelV3StatusCallbackPayload['call_details'],
  direction: 'incoming' | 'outbound'
): string => {
  const raw = callDetails as any
  const candidates = direction === 'incoming'
    ? [
        raw.from,
        raw.from_number,
        raw.fromNumber,
        raw.from_contact_uri,
        raw.customer_number,
        raw.customerNumber,
        raw.customer,
        raw.caller,
        raw.caller_id,
      ]
    : [
        raw.to,
        raw.to_number,
        raw.toNumber,
        raw.to_contact_uri,
        raw.customer_number,
        raw.customerNumber,
        raw.customer,
      ]

  for (const candidate of candidates) {
    const value = readManagedPhoneCandidate(candidate)
    if (normalizePhone(value)) {
      return value
    }
  }

  return ''
}

const findOrCreateManagedIncomingLead = async (
  rawPhoneNumber: string,
  callSid: string,
  status?: string | null
): Promise<{ lead: any; created: boolean } | null> => {
  const normalizedPhone = normalizePhone(rawPhoneNumber)
  if (!normalizedPhone && !rawPhoneNumber) return null

  let lead = null
  let created = false

  if (normalizedPhone) {
    lead = await Lead.findOne({ $or: [{ phone: { $regex: `${normalizedPhone}$` } }, { alternatePhone: { $regex: `${normalizedPhone}$` } }] }).exec()
  }
  if (!lead && normalizedPhone) {
    lead = await Lead.findOne({ $or: [{ phone: normalizedPhone }, { alternatePhone: normalizedPhone }] }).exec()
  }
  if (!lead && rawPhoneNumber) {
    lead = await Lead.findOne({ $or: [{ phone: rawPhoneNumber }, { alternatePhone: rawPhoneNumber }] }).exec()
  }

  if (!lead) {
    // Do not auto-recreate leads that were explicitly deleted by a manager
    const blocked = await DeletedLeadPhone.findOne({ phone: normalizedPhone || normalizePhone(rawPhoneNumber) }).lean()
    if (blocked) {
      logger.info('Skipping lead auto-creation — phone is on deleted-lead blocklist', { phone: normalizedPhone || rawPhoneNumber })
      return null
    }

    lead = await Lead.create({
      name: buildExotelLeadName(normalizedPhone || rawPhoneNumber),
      phone: normalizedPhone || rawPhoneNumber,
      source: 'Direct',
      disposition: 'New',
      city: 'Unknown',
      lastActivity: new Date(),
      lastActivityNote: buildManagedLeadNote(callSid, status),
    })
    created = true
  }

  // Only update name if it's a placeholder — never overwrite a real name
  if ((!lead.name || /^Lead\s+\d{4}$/i.test(lead.name) || /^Exotel\s+\d{4}$/i.test(lead.name) || /^Direct\s+\d{4}$/i.test(lead.name)) && (normalizedPhone || rawPhoneNumber)) {
    lead.name = buildExotelLeadName(normalizedPhone || rawPhoneNumber)
  }
  lead.lastActivity = new Date()
  if (!lead.lastActivityNote || lead.lastActivityNote.startsWith('Exotel ')) {
    lead.lastActivityNote = buildManagedLeadNote(callSid, status)
  }
  await lead.save()

  if (created) {
    emitIncomingLeadEvent(lead)
    void notifyNewLeadCreated(lead).catch(() => null)
  }

  return { lead, created }
}

const isV3Payload = (payload: unknown): payload is ExotelV3StatusCallbackPayload => {
  const candidate = payload as ExotelV3StatusCallbackPayload | undefined
  return Boolean(candidate?.event_details?.event_type && candidate?.call_details?.sid)
}

const extractBuildFlowMetadata = (raw?: string | null): { leadId?: string; representativeId?: string } => {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw)
    return {
      leadId: parsed?.leadId ? String(parsed.leadId) : undefined,
      representativeId: parsed?.representativeId ? String(parsed.representativeId) : undefined,
    }
  } catch {
    return {}
  }
}

const mapDialOutcome = (dialStatus?: string): string | null => {
  switch (dialStatus?.toLowerCase()) {
    case 'completed':
    case 'answered':
    case 'successful':
    case 'success':
      return 'Connected'
    case 'no-answer':
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'Not Answered'
    case 'busy':
      return 'Busy'
    case 'voicemail':
      return 'Voicemail'
    case 'wrong-number':
      return 'Wrong Number'
    case 'callback-requested':
    case 'callback_requested':
    case 'call-back-later':
    case 'call_back_later':
      return 'Call Back Later'
    default:
      return null
  }
}

const mapLegacyStatus = (status?: string, dialStatus?: string): string => {
  const normalized = (dialStatus || status || '').toLowerCase()
  switch (normalized) {
    case 'completed':
    case 'success':
    case 'successful':
      return 'completed'
    case 'in-progress':
      return 'in-progress'
    case 'ringing':
      return 'ringing'
    case 'busy':
      return 'busy'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'no-answer':
      return 'no-answer'
    case 'failed':
      return 'failed'
    default:
      return 'initiated'
  }
}

const mapManagedStatus = (status?: string | null, eventType?: 'answered' | 'terminal'): string => {
  const normalized = (status || '').toLowerCase()
  if (eventType === 'answered') return 'in-progress'

  switch (normalized) {
    case 'completed':
      return 'completed'
    case 'from_leg_cancelled':
      return 'canceled'
    case 'from_leg_unanswered':
      return 'failed'
    case 'to_leg_unanswered':
      return 'no-answer'
    default:
      return 'failed'
  }
}

const mapManagedOutcome = (status?: string | null): string | null => {
  const normalized = (status || '').toLowerCase()
  switch (normalized) {
    case 'completed':
      return 'Connected'
    case 'to_leg_unanswered':
    case 'from_leg_unanswered':
    case 'from_leg_cancelled':
      return 'Not Answered'
    default:
      return null
  }
}

const deriveLegState = (
  rawStatus?: string | null,
  direction: 'incoming' | 'outbound' = 'outbound'
) => {
  const normalized = (rawStatus || '').toLowerCase()

  if (!normalized) {
    return {
      exotelStatusRaw: null,
      representativeLegStatus: null,
      customerLegStatus: null,
      representativeAnswered: null,
      customerAnswered: null,
    }
  }

  if (direction === 'incoming') {
    switch (normalized) {
      case 'completed':
        return {
          exotelStatusRaw: rawStatus || null,
          representativeLegStatus: 'completed',
          customerLegStatus: 'completed',
          representativeAnswered: true,
          customerAnswered: true,
        }
      case 'busy':
        return {
          exotelStatusRaw: rawStatus || null,
          representativeLegStatus: 'busy',
          customerLegStatus: 'completed',
          representativeAnswered: false,
          customerAnswered: true,
        }
      case 'no-answer':
      case 'no_answer':
      case 'failed':
      case 'canceled':
      case 'cancelled':
        return {
          exotelStatusRaw: rawStatus || null,
          representativeLegStatus: 'unanswered',
          customerLegStatus: 'completed',
          representativeAnswered: false,
          customerAnswered: true,
        }
      default:
        return {
          exotelStatusRaw: rawStatus || null,
          representativeLegStatus: null,
          customerLegStatus: null,
          representativeAnswered: null,
          customerAnswered: null,
        }
    }
  }

  switch (normalized) {
    case 'initiated':
    case 'queued':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'dialing',
        customerLegStatus: 'waiting',
        representativeAnswered: null,
        customerAnswered: null,
      }
    case 'ringing':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'completed',
        customerLegStatus: 'ringing',
        representativeAnswered: true,
        customerAnswered: null,
      }
    case 'in-progress':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'completed',
        customerLegStatus: 'completed',
        representativeAnswered: true,
        customerAnswered: true,
      }
    case 'completed':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'completed',
        customerLegStatus: 'completed',
        representativeAnswered: true,
        customerAnswered: true,
      }
    case 'from_leg_unanswered':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'unanswered',
        customerLegStatus: 'not-dialed',
        representativeAnswered: false,
        customerAnswered: false,
      }
    case 'from_leg_cancelled':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'cancelled',
        customerLegStatus: 'not-answered',
        representativeAnswered: false,
        customerAnswered: false,
      }
    case 'to_leg_unanswered':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'completed',
        customerLegStatus: 'unanswered',
        representativeAnswered: true,
        customerAnswered: false,
      }
    case 'to_leg_no_dial':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'completed',
        customerLegStatus: 'not-dialed',
        representativeAnswered: true,
        customerAnswered: false,
      }
    case 'from_leg_no_dial':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'not-dialed',
        customerLegStatus: 'not-dialed',
        representativeAnswered: false,
        customerAnswered: false,
      }
    case 'busy':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: null,
        customerLegStatus: 'busy',
        representativeAnswered: null,
        customerAnswered: false,
      }
    case 'no-answer':
    case 'no_answer':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: null,
        customerLegStatus: 'unanswered',
        representativeAnswered: null,
        customerAnswered: false,
      }
    case 'failed':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: null,
        customerLegStatus: 'failed',
        representativeAnswered: null,
        customerAnswered: false,
      }
    case 'canceled':
    case 'cancelled':
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: 'cancelled',
        customerLegStatus: 'cancelled',
        representativeAnswered: false,
        customerAnswered: false,
      }
    default:
      return {
        exotelStatusRaw: rawStatus || null,
        representativeLegStatus: null,
        customerLegStatus: null,
        representativeAnswered: null,
        customerAnswered: null,
      }
  }
}

const setRepresentativeAvailability = async (
  representativeId: string,
  status: 'available' | 'in-call',
  callSid?: string | null
) => {
  if (status === 'in-call') {
    const representative = await User.findByIdAndUpdate(representativeId, {
      callAvailabilityStatus: 'in-call',
      ...(callSid && { activeCallSid: callSid }),
    }, { new: true }).select('name email role phone isActive callDeviceMode callAvailabilityStatus activeCallSid')

    if (representative) {
      emitUserAvailabilityUpdate({
        id: String(representative._id),
        name: representative.name,
        email: representative.email,
        role: representative.role,
        phone: representative.phone || null,
        callAvailabilityStatus: representative.callAvailabilityStatus || 'in-call',
        callDeviceMode: representative.callDeviceMode || 'phone',
        activeCallSid: representative.activeCallSid || callSid || null,
        isActive: representative.isActive,
      })
    }
    return
  }

  const representative = await User.findById(representativeId).select('activeCallSid')
  if (!representative) return
  if (!callSid || !representative.activeCallSid || representative.activeCallSid === callSid) {
    const updated = await User.findByIdAndUpdate(representativeId, {
      callAvailabilityStatus: 'available',
      activeCallSid: null,
    }, { new: true }).select('name email role phone isActive callDeviceMode callAvailabilityStatus activeCallSid')

    if (updated) {
      emitUserAvailabilityUpdate({
        id: String(updated._id),
        name: updated.name,
        email: updated.email,
        role: updated.role,
        phone: updated.phone || null,
        callAvailabilityStatus: updated.callAvailabilityStatus || 'available',
        callDeviceMode: updated.callDeviceMode || 'phone',
        activeCallSid: updated.activeCallSid || null,
        isActive: updated.isActive,
      })
    }
  }
}

const setRepresentativePendingCall = async (representativeId: string, callSid?: string | null) => {
  const representative = await User.findByIdAndUpdate(
    representativeId,
    { ...(callSid && { activeCallSid: callSid }) },
    { new: true }
  ).select('name email role phone isActive callDeviceMode callAvailabilityStatus activeCallSid')

  if (!representative) return

  emitUserAvailabilityUpdate({
    id: String(representative._id),
    name: representative.name,
    email: representative.email,
    role: representative.role,
    phone: representative.phone || null,
    callAvailabilityStatus: representative.callAvailabilityStatus || 'available',
    callDeviceMode: representative.callDeviceMode || 'phone',
    activeCallSid: representative.activeCallSid || callSid || null,
    isActive: representative.isActive,
  })
}

const emitCallEvent = (eventName: 'call:new' | 'call:status_updated', call: any) => {
  emitToTeam('all', eventName, {
    _id: String(call._id),
    exotelCallSid: call.exotelCallSid,
    exophoneNumber: call.exophoneNumber || null,
    exotelStatusRaw: call.exotelStatusRaw || null,
    leadName: call.leadName,
    phone: call.phone,
    status: call.status,
    outcome: call.outcome,
    representativeLegStatus: call.representativeLegStatus || null,
    customerLegStatus: call.customerLegStatus || null,
    representativeAnswered: call.representativeAnswered ?? null,
    customerAnswered: call.customerAnswered ?? null,
    direction: call.direction,
    duration: call.duration,
    recordingRequested: call.recordingRequested ?? null,
    recordingUrl: call.recordingUrl,
    recordingS3Key: call.recordingS3Key,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    representative: call.representative,
    representativeName: call.representativeName,
    lead: call.lead,
  })
}

const runTerminalPostProcessing = async (
  call: any,
  options: { callSid: string; recordingUrl?: string | null; outcome?: string | null }
) => {
  if (options.outcome === 'Connected') {
    await Lead.findByIdAndUpdate(
      { _id: call.lead, disposition: 'New' },
      { lastActivity: new Date(), disposition: 'Contacted/Open' }
    )
  }

  if (call.representative) {
    await setRepresentativeAvailability(String(call.representative), 'available', options.callSid)
  }

  const recordingUrl = options.recordingUrl || call.recordingUrl
  if (!recordingUrl) return

  const s3Key = `${S3_RECORDINGS_PREFIX}${options.callSid}.mp3`
  const s3Url = await uploadFromUrl(recordingUrl, s3Key, 'audio/mpeg')
  if (s3Url) {
    call.recordingS3Key = s3Key
    await call.save()
    logger.info('Recording mirrored to S3', { callSid: options.callSid, s3Key })
  }

  const jobId = await triggerExoVoiceAnalyze(options.callSid, String(call._id))
  if (jobId) {
    call.aiAnalysisStatus = 'processing'
    call.aiJobId = jobId
    await call.save()
  }
}

const findOrCreateExotelLead = async (
  payload: ExotelCallStatusPayload,
  isIncoming: boolean
): Promise<{ lead: any; created: boolean } | null> => {
  const rawPhoneNumber = isIncoming ? payload.From : payload.To
  if (!rawPhoneNumber) return null

  const normalizedPhone = normalizePhone(rawPhoneNumber)
  let lead = null
  let created = false

  if (normalizedPhone) {
    lead = await Lead.findOne({ $or: [{ phone: { $regex: `${normalizedPhone}$` } }, { alternatePhone: { $regex: `${normalizedPhone}$` } }] }).exec()
  }
  if (!lead && normalizedPhone) {
    lead = await Lead.findOne({ $or: [{ phone: normalizedPhone }, { alternatePhone: normalizedPhone }] }).exec()
  }
  if (!lead && rawPhoneNumber) {
    lead = await Lead.findOne({ $or: [{ phone: rawPhoneNumber }, { alternatePhone: rawPhoneNumber }] }).exec()
  }

  if (!lead && !isIncoming) {
    return null
  }

  if (!lead) {
    // Do not auto-recreate leads that were explicitly deleted by a manager
    const blocked = await DeletedLeadPhone.findOne({ phone: normalizedPhone || normalizePhone(rawPhoneNumber) }).lean()
    if (blocked) {
      logger.info('Skipping lead auto-creation — phone is on deleted-lead blocklist', { phone: normalizedPhone || rawPhoneNumber })
      return null
    }

    lead = await Lead.create({
      name: buildExotelLeadName(normalizedPhone || rawPhoneNumber),
      phone: normalizedPhone || rawPhoneNumber,
      source: 'Direct',
      disposition: 'New',
      city: 'Unknown',
      lastActivity: new Date(),
      lastActivityNote: buildExotelLeadNote(payload),
    })
    created = true
  }

  // Only update name if it is still a generated placeholder — never overwrite a real name
  if ((!lead.name || /^Lead\s+\d{4}$/i.test(lead.name) || /^Exotel\s+\d{4}$/i.test(lead.name) || /^Direct\s+\d{4}$/i.test(lead.name)) && (normalizedPhone || rawPhoneNumber)) {
    lead.name = buildExotelLeadName(normalizedPhone || rawPhoneNumber)
  }
  lead.lastActivity = new Date()
  if (!lead.lastActivityNote || lead.lastActivityNote.startsWith('Exotel ')) {
    lead.lastActivityNote = buildExotelLeadNote(payload)
  }
  await lead.save()

  if (created) {
    emitIncomingLeadEvent(lead)
    void notifyNewLeadCreated(lead).catch(() => null)
  }

  return { lead, created }
}

const processLegacyCallback = async (payload: ExotelCallStatusPayload): Promise<void> => {
  const {
    EventType,
    CallSid,
    Status,
    DialCallStatus,
    RecordingUrl,
    Duration,
    DialCallDuration,
    ConversationDuration,
    StartTime,
    EndTime,
    From,
    Direction,
    AnsweredBy,
  } = payload

  logger.info('Exotel legacy call-status callback received', {
    CallSid,
    EventType,
    Status,
    DialCallStatus,
    hasRecordingUrl: Boolean(RecordingUrl),
    From,
    Direction,
  })

  const outcome = mapDialOutcome(DialCallStatus) ?? mapDialOutcome(Status)
  const duration = parseInt(String(DialCallDuration || Duration || ConversationDuration || '0'), 10)
  const isIncoming = ['incoming', 'inbound'].includes(Direction?.toLowerCase() || '')
  const direction = isIncoming ? 'incoming' : 'outbound'
  const exophoneNumber = isIncoming ? payload.To || null : null
  const rawStatus = DialCallStatus || Status || null
  const legState = deriveLegState(rawStatus, direction)

  let call = await Call.findOne({ exotelCallSid: CallSid })
  let created = false

  if (!call) {
    const leadResult = await findOrCreateExotelLead(payload, isIncoming)
    if (!leadResult) {
      logger.warn('Exotel legacy webhook: Missing lead phone for new call', { CallSid })
      return
    }
    const lead = leadResult.lead

    const manager = (await User.findOne({ role: 'manager', isActive: true })) || (await User.findOne({ isActive: true }))
    if (!manager) {
      logger.error('Exotel legacy webhook: No active user found to assign call')
      return
    }

    let representativeUser: typeof manager | null = null

    if (isIncoming) {
      // For incoming calls Exotel sets AnsweredBy to the agent's phone who picked up
      const answeredByPhone = normalizePhone(AnsweredBy)
      if (answeredByPhone) {
        representativeUser = await User.findOne({
          isActive: true,
          phone: { $regex: `${answeredByPhone}$` },
        }).exec()
      }
      // If AnsweredBy didn't match, try to find any agent currently marked in-call
      if (!representativeUser) {
        representativeUser = await User.findOne({
          isActive: true,
          callAvailabilityStatus: 'in-call',
        }).exec()
      }
    } else {
      // For outbound calls From is the agent's phone (Exotel bridges them first)
      const repPhone = normalizePhone(From)
      if (repPhone) {
        representativeUser = await User.findOne({
          isActive: true,
          phone: { $regex: `${repPhone}$` },
        }).exec()
      }
    }

    const representative = representativeUser?._id ?? manager._id
    const representativeName = representativeUser?.name ?? manager.name

    call = await Call.create({
      lead: lead._id,
      leadName: lead.name,
      phone: lead.phone,
      representative,
      representativeName,
      exophoneNumber,
      exotelCallSid: CallSid,
      exotelStatusRaw: legState.exotelStatusRaw,
      direction,
      status: mapLegacyStatus(Status, DialCallStatus),
      outcome,
      representativeLegStatus: legState.representativeLegStatus,
      customerLegStatus: legState.customerLegStatus,
      representativeAnswered: legState.representativeAnswered,
      customerAnswered: legState.customerAnswered,
      duration,
      startedAt: parseIstDate(StartTime) ?? new Date(),
      endedAt: parseIstDate(EndTime) ?? undefined,
      ...(RecordingUrl && { recordingUrl: RecordingUrl }),
    })
    created = true

    // Assign the lead to whoever answered the incoming call when the lead is new or has no owner
    if (isIncoming && (!lead.owner || leadResult.created)) {
      await Lead.findByIdAndUpdate(lead._id, {
        owner: representative,
        ownerName: representativeName,
        assignedAt: new Date(),
      })
      lead.owner = representative
      lead.ownerName = representativeName
      // Emit updated lead info so the frontend refreshes the assignment
      emitToTeam('all', 'lead:updated', {
        _id: String(lead._id),
        owner: representative,
        ownerName: representativeName,
        isNewLead: leadResult.created,
      })
    }

  } else {
    call.exotelStatusRaw = legState.exotelStatusRaw
    if (exophoneNumber) {
      call.exophoneNumber = exophoneNumber
    }
    call.status = mapLegacyStatus(Status, DialCallStatus)
    call.outcome = outcome
    call.duration = duration
    call.direction = direction
    call.representativeLegStatus = legState.representativeLegStatus
    call.customerLegStatus = legState.customerLegStatus
    call.representativeAnswered = legState.representativeAnswered
    call.customerAnswered = legState.customerAnswered
    if (RecordingUrl) call.recordingUrl = RecordingUrl
    if (StartTime) call.startedAt = parseIstDate(StartTime) ?? call.startedAt
    if (EndTime) call.endedAt = parseIstDate(EndTime) ?? call.endedAt

    if (isIncoming) {
      // For incoming calls update representative as soon as we know who answered
      const answeredByPhone = normalizePhone(AnsweredBy)
      if (answeredByPhone) {
        const representativeUser = await User.findOne({
          isActive: true,
          phone: { $regex: `${answeredByPhone}$` },
        }).exec()
        if (representativeUser) {
          call.representative = representativeUser._id
          call.representativeName = representativeUser.name
        }
      }
    } else {
      const repPhone = normalizePhone(From)
      if (repPhone) {
        const representativeUser = await User.findOne({
          isActive: true,
          phone: { $regex: `${repPhone}$` },
        }).exec()

        if (representativeUser) {
          call.representative = representativeUser._id
          call.representativeName = representativeUser.name
        }
      }
    }

    // Assign unowned lead to whoever is now on the call
    if (isIncoming && call.representative && call.lead) {
      const existingLead = await Lead.findById(call.lead).select('owner').exec()
      if (existingLead && !existingLead.owner) {
        await Lead.findByIdAndUpdate(call.lead, {
          owner: call.representative,
          ownerName: call.representativeName,
          assignedAt: new Date(),
        })
        emitToTeam('all', 'lead:updated', {
          _id: String(call.lead),
          owner: call.representative,
          ownerName: call.representativeName,
          isNewLead: false,
        })
      }
    }

    await call.save()
  }

  if (call.representative && call.status === 'in-progress') {
    await setRepresentativeAvailability(String(call.representative), 'in-call', CallSid)
  } else if (call.representative && call.status === 'ringing') {
    await setRepresentativePendingCall(String(call.representative), CallSid)
  }

  const isTerminal = EventType?.toLowerCase() === 'terminal' || call.status === 'completed'
  if (isTerminal) {
    await runTerminalPostProcessing(call, {
      callSid: CallSid,
      recordingUrl: RecordingUrl,
      outcome,
    })
    void notifyMissedCall(String(call._id)).catch(() => null)
  }

  emitCallEvent(created ? 'call:new' : 'call:status_updated', call)
}

const processManagedCallback = async (payload: ExotelV3StatusCallbackPayload): Promise<void> => {
  const eventType = payload.event_details.event_type
  const callDetails = payload.call_details
  const callSid = callDetails.sid
  const metadata = extractBuildFlowMetadata(callDetails.custom_field)
  const direction = callDetails.direction?.startsWith('inbound') ? 'incoming' : 'outbound'
  const exophoneNumber = callDetails.virtual_number || null

  logger.info('Exotel managed call-status callback received', {
    callSid,
    eventType,
    status: callDetails.status,
    state: callDetails.state,
  })

  let call = await Call.findOne({ exotelCallSid: callSid })
  let created = false
  const activeLegState = eventType === 'answered'
    ? deriveLegState('in-progress', direction)
    : deriveLegState(callDetails.status, direction)

  if (!call && !metadata.leadId && !metadata.representativeId) {
    await syncExotelCallHistory({
      emitEvents: false,
      maxPages: 1,
      pageSize: 10,
      sids: [callSid],
    })

    call = await Call.findOne({ exotelCallSid: callSid })

    if (call && direction === 'incoming' && call.lead) {
      const syncedLead = await Lead.findById(call.lead).select('name phone city source owner')
      if (syncedLead) {
        emitIncomingLeadEvent(syncedLead)
      }
    }
  }

  if (!call && direction === 'incoming') {
    const rawLeadPhone = extractManagedLeadPhone(callDetails, direction)
    const leadResult = await findOrCreateManagedIncomingLead(rawLeadPhone, callSid, callDetails.status)

    if (leadResult?.lead) {
      // --- Identify who answered the incoming call ---
      // V3 managed calls may carry leg data; fall back to any in-call agent then manager
      let answeredRep: any = null
      const rawDetails = callDetails as any

      // Try to extract answering agent from legs array (V3 bridge legs)
      if (rawDetails.legs) {
        let legs = rawDetails.legs
        if (typeof legs === 'string') {
          try { legs = JSON.parse(legs) } catch { legs = null }
        }
        if (Array.isArray(legs)) {
          for (const leg of legs) {
            const legStatus = (leg.status || '').toLowerCase()
            if (legStatus === 'completed' || legStatus === 'answered' || legStatus === 'in-progress') {
              // In an inbound call the agent is the "to" leg
              const legPhone = normalizePhone(
                readManagedPhoneCandidate(leg.to) || readManagedPhoneCandidate(leg.to_uri) || readManagedPhoneCandidate(leg.to_number)
              )
              if (legPhone) {
                answeredRep = await User.findOne({ isActive: true, phone: { $regex: `${legPhone}$` } }).exec()
                if (answeredRep) break
              }
            }
          }
        }
      }

      // Fallback: any agent currently marked in-call
      if (!answeredRep) {
        answeredRep = await User.findOne({ isActive: true, callAvailabilityStatus: 'in-call' }).exec()
      }

      // Last resort: manager / any active user
      if (!answeredRep) {
        answeredRep = (await User.findOne({ role: 'manager', isActive: true })) || (await User.findOne({ isActive: true }))
      }

      if (!answeredRep) {
        logger.error('Exotel managed incoming webhook: No active user found to assign call')
        return
      }

      // Store the actual caller's number (rawLeadPhone), not always the primary phone,
      // so alternate-number calls are logged with the real number dialled
      const callerPhone = normalizePhone(rawLeadPhone) || rawLeadPhone || leadResult.lead.phone
      call = await Call.create({
        lead: leadResult.lead._id,
        leadName: leadResult.lead.name,
        phone: callerPhone,
        representative: answeredRep._id,
        representativeName: answeredRep.name,
        exophoneNumber,
        exotelCallSid: callSid,
        exotelStatusRaw: activeLegState.exotelStatusRaw,
        direction,
        status: eventType === 'answered' ? 'in-progress' : mapManagedStatus(callDetails.status, eventType),
        outcome: eventType === 'terminal' ? mapManagedOutcome(callDetails.status) : null,
        representativeLegStatus: activeLegState.representativeLegStatus,
        customerLegStatus: activeLegState.customerLegStatus,
        representativeAnswered: activeLegState.representativeAnswered,
        customerAnswered: activeLegState.customerAnswered,
        duration: callDetails.total_talk_time || callDetails.total_duration || 0,
        startedAt: parseIstDate(callDetails.start_time) ?? new Date(),
        endedAt: parseIstDate(callDetails.end_time) ?? undefined,
        recordingUrl: callDetails.recordings?.[0]?.url || null,
      })
      created = true

      // Assign lead to whoever answered when the lead is new or has no owner
      if (!leadResult.lead.owner || leadResult.created) {
        await Lead.findByIdAndUpdate(leadResult.lead._id, {
          owner: answeredRep._id,
          ownerName: answeredRep.name,
          assignedAt: new Date(),
        })
        emitToTeam('all', 'lead:updated', {
          _id: String(leadResult.lead._id),
          owner: answeredRep._id,
          ownerName: answeredRep.name,
          isNewLead: leadResult.created,
        })
      }
    }
  }

  if (!call && metadata.leadId && metadata.representativeId) {
    const [lead, representative] = await Promise.all([
      Lead.findById(metadata.leadId),
      User.findById(metadata.representativeId).select('name'),
    ])

    if (lead && representative) {
      // Use the actual dialed phone from callDetails so alternate-number calls
      // are logged with the real number, not always the primary phone
      const rawDialedPhone = extractManagedLeadPhone(callDetails, direction)
      const dialedPhone = normalizePhone(rawDialedPhone) || rawDialedPhone || lead.phone
      call = await Call.create({
        lead: lead._id,
        leadName: lead.name,
        phone: dialedPhone,
        representative: metadata.representativeId,
        representativeName: representative.name,
        exophoneNumber,
        exotelCallSid: callSid,
        exotelStatusRaw: activeLegState.exotelStatusRaw,
        direction,
        status: eventType === 'answered' ? 'in-progress' : mapManagedStatus(callDetails.status, eventType),
        outcome: eventType === 'terminal' ? mapManagedOutcome(callDetails.status) : null,
        representativeLegStatus: activeLegState.representativeLegStatus,
        customerLegStatus: activeLegState.customerLegStatus,
        representativeAnswered: activeLegState.representativeAnswered,
        customerAnswered: activeLegState.customerAnswered,
        duration: callDetails.total_talk_time || callDetails.total_duration || 0,
        startedAt: parseIstDate(callDetails.start_time) ?? new Date(),
        endedAt: parseIstDate(callDetails.end_time) ?? undefined,
        recordingUrl: callDetails.recordings?.[0]?.url || null,
      })
      created = true
    }
  }

  if (!call) {
    logger.warn('Exotel managed callback received before BuildFlow call record existed', { callSid, metadata })
    return
  }

  call.exotelStatusRaw = activeLegState.exotelStatusRaw
  call.direction = direction
  if (exophoneNumber) {
    call.exophoneNumber = exophoneNumber
  }
  call.duration = callDetails.total_talk_time || callDetails.total_duration || call.duration || 0
  call.representativeLegStatus = activeLegState.representativeLegStatus
  call.customerLegStatus = activeLegState.customerLegStatus
  call.representativeAnswered = activeLegState.representativeAnswered
  call.customerAnswered = activeLegState.customerAnswered
  if (callDetails.start_time) call.startedAt = parseIstDate(callDetails.start_time) ?? call.startedAt
  if (callDetails.end_time) call.endedAt = parseIstDate(callDetails.end_time) ?? call.endedAt
  if (callDetails.recordings?.[0]?.url) {
    call.recordingUrl = callDetails.recordings[0].url
  }

  if (eventType === 'answered') {
    call.status = 'in-progress'

    // On 'answered' event try to update representative from legs if not already identified
    if (direction === 'incoming') {
      const rawDetails = callDetails as any
      if (rawDetails.legs) {
        let legs = rawDetails.legs
        if (typeof legs === 'string') {
          try { legs = JSON.parse(legs) } catch { legs = null }
        }
        if (Array.isArray(legs)) {
          for (const leg of legs) {
            const legStatus = (leg.status || '').toLowerCase()
            if (legStatus === 'completed' || legStatus === 'answered' || legStatus === 'in-progress') {
              const legPhone = normalizePhone(
                readManagedPhoneCandidate(leg.to) || readManagedPhoneCandidate(leg.to_uri) || readManagedPhoneCandidate(leg.to_number)
              )
              if (legPhone) {
                const legRep = await User.findOne({ isActive: true, phone: { $regex: `${legPhone}$` } }).exec()
                if (legRep) {
                  call.representative = legRep._id
                  call.representativeName = legRep.name
                  // Assign lead to whoever answered when unowned
                  if (call.lead) {
                    const existingLead = await Lead.findById(call.lead).select('owner').exec()
                    if (existingLead && !existingLead.owner) {
                      await Lead.findByIdAndUpdate(call.lead, {
                        owner: legRep._id,
                        ownerName: legRep.name,
                        assignedAt: new Date(),
                      })
                      emitToTeam('all', 'lead:updated', {
                        _id: String(call.lead),
                        owner: legRep._id,
                        ownerName: legRep.name,
                        isNewLead: false,
                      })
                    }
                  }
                  break
                }
              }
            }
          }
        }
      }
    }

    await call.save()
    if (call.representative) {
      await setRepresentativeAvailability(String(call.representative), 'in-call', callSid)
    }
    emitCallEvent(created ? 'call:new' : 'call:status_updated', call)
    return
  }

  call.status = mapManagedStatus(callDetails.status, eventType)
  call.outcome = mapManagedOutcome(callDetails.status)
  await call.save()

  await runTerminalPostProcessing(call, {
    callSid,
    recordingUrl: call.recordingUrl,
    outcome: call.outcome,
  })

  void notifyMissedCall(String(call._id)).catch(() => null)

  emitCallEvent(created ? 'call:new' : 'call:status_updated', call)
}

export const processExotelCallStatus = async (
  payload: ExotelCallStatusPayload | ExotelV3StatusCallbackPayload
): Promise<void> => {
  try {
    if (isV3Payload(payload)) {
      await processManagedCallback(payload)
      return
    }

    await processLegacyCallback(payload)
  } catch (err) {
    logger.error('processExotelCallStatus error', err)
  }
}
