import { Call } from '../models/Call'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { DeletedLeadPhone } from '../models/DeletedLeadPhone'
import { emitToTeam, emitUserAvailabilityUpdate } from '../config/socket'
import { exotelConfig } from '../config/exotel'
import { listCalls } from './exotel.service'
import { ExotelBulkCall } from '../types/exotel.types'
import { logger } from '../utils/logger'
import { notifyMissedCall, notifyNewLeadCreated } from './notification.service'

type LocalCallStatus =
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'no-answer'
  | 'busy'
  | 'canceled'

interface SyncExotelHistoryOptions {
  after?: string
  dateFrom?: Date
  dateTo?: Date
  days?: number
  emitEvents?: boolean
  maxPages?: number
  pageSize?: number
  sids?: string[]
}

export interface SyncExotelHistoryResult {
  createdCount: number
  fetchedCount: number
  pagesFetched: number
  unchangedCount: number
  updatedCount: number
}

export interface AvailabilityReconciliationResult {
  repairedCount: number
}

interface ActiveUserLite {
  _id: string
  name: string
  phone?: string
  role: 'manager' | 'representative'
  email?: string
  callAvailabilityStatus?: 'available' | 'offline' | 'in-call'
  callDeviceMode?: 'phone' | 'web'
  activeCallSid?: string | null
  isActive?: boolean
}

interface ExotelLegState {
  exotelStatusRaw: string | null
  representativeLegStatus: string | null
  customerLegStatus: string | null
  representativeAnswered: boolean | null
  customerAnswered: boolean | null
}

const DETAILED_LEG_STATUSES = new Set([
  'from_leg_unanswered',
  'to_leg_unanswered',
  'from_leg_cancelled',
  'to_leg_no_dial',
  'from_leg_no_dial',
  'ringing',
  'in-progress',
])

const TERMINAL_STATUSES = new Set<LocalCallStatus>(['completed', 'failed', 'no-answer', 'busy', 'canceled'])

const normalizePhone = (value?: string | null): string => {
  if (!value) return ''

  const digits = value.replace(/\D/g, '')
  if (!digits) return ''

  const stripped = digits.replace(/^0+/, '')
  if (stripped.length <= 10) return stripped
  return stripped.slice(-10)
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

const formatExotelDate = (value: Date): string => {
  const ist = new Date(value.getTime() + IST_OFFSET_MS)
  const year = ist.getUTCFullYear()
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const day = String(ist.getUTCDate()).padStart(2, '0')
  const hours = String(ist.getUTCHours()).padStart(2, '0')
  const minutes = String(ist.getUTCMinutes()).padStart(2, '0')
  const seconds = String(ist.getUTCSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

const parseExotelDate = (value?: string | null): Date | null => {
  if (!value) return null

  const hasTimezone = value.includes('Z') || value.includes('+') || (value.includes('-') && value.lastIndexOf('-') > 7)
  if (hasTimezone) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const parsedAsIst = new Date(normalized + '+05:30')
  return Number.isNaN(parsedAsIst.getTime()) ? null : parsedAsIst
}

const normalizeStatus = (status?: string | null): LocalCallStatus => {
  switch ((status || '').toLowerCase()) {
    case 'ringing':
      return 'ringing'
    case 'in-progress':
      return 'in-progress'
    case 'completed':
    case 'answered':
    case 'successful':
    case 'success':
      return 'completed'
    case 'busy':
      return 'busy'
    case 'failed':
      return 'failed'
    case 'no-answer':
    case 'no_answer':
      return 'no-answer'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    default:
      return 'initiated'
  }
}

const deriveLegState = (
  rawStatus?: string | null,
  direction: 'incoming' | 'outbound' = 'outbound'
): ExotelLegState => {
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

const shouldPreserveExistingLegState = (
  currentRawStatus?: string | null,
  nextRawStatus?: string | null
) => {
  const current = (currentRawStatus || '').toLowerCase()
  const next = (nextRawStatus || '').toLowerCase()
  return Boolean(current && DETAILED_LEG_STATUSES.has(current) && (!next || !DETAILED_LEG_STATUSES.has(next)))
}

const mapExotelOutcome = (status?: string | null): string | null => {
  switch (normalizeStatus(status)) {
    case 'completed':
      return 'Connected'
    case 'busy':
      return 'Busy'
    case 'failed':
    case 'no-answer':
    case 'canceled':
      return 'Not Answered'
    default:
      return null
  }
}

const getDirection = (direction?: string | null): 'incoming' | 'outbound' => {
  const normalized = (direction || '').toLowerCase()
  return normalized === 'incoming' || normalized === 'inbound' ? 'incoming' : 'outbound'
}

const toDuration = (value?: string | number | null): number => {
  if (value === undefined || value === null || value === '') return 0

  const parsed = typeof value === 'number' ? value : parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

const getLeadPhoneFromCall = (record: ExotelBulkCall): string => {
  const localDirection = getDirection(record.Direction)
  return localDirection === 'incoming' ? record.From || record.To || '' : record.To || record.From || ''
}

const getExophoneNumberFromCall = (record: ExotelBulkCall): string | null => {
  const localDirection = getDirection(record.Direction)
  if (localDirection === 'incoming') {
    return record.To || record.PhoneNumber || record.PhoneNumberSid || null
  }

  return record.PhoneNumber || record.PhoneNumberSid || null
}

const buildExotelLeadName = (record: ExotelBulkCall, phone: string): string => {
  const callerName = (record.CallerName || '').trim()
  if (getDirection(record.Direction) === 'incoming' && callerName) return callerName

  const normalizedPhone = normalizePhone(phone)
  return normalizedPhone ? `Direct ${normalizedPhone.slice(-4)}` : 'Direct Lead'
}

const buildExotelLeadNote = (record: ExotelBulkCall): string => {
  const parts = [
    `Exotel ${getDirection(record.Direction)} call`,
    record.PhoneNumberSid ? `VN ${record.PhoneNumberSid}` : null,
    record.Status ? `status ${record.Status}` : null,
    record.CustomField && record.CustomField !== 'N/A' ? `custom ${record.CustomField}` : null,
    record.Sid ? `sid ${record.Sid}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
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

  void notifyNewLeadCreated(lead).catch(() => null)
}

const applyExotelLeadMetadata = async (
  lead: any,
  record: ExotelBulkCall,
  activityAt: Date | null,
  phoneFallback: string,
  direction: 'incoming' | 'outbound'
) => {
  const expectedName = buildExotelLeadName(record, phoneFallback)
  const expectedNote = buildExotelLeadNote(record)
  let shouldSave = false

  // Only set source to "Direct" for leads that don't already have a meaningful source.
  // Never overwrite sources like Referral, Meta, Google, etc. that were set manually or via import.
  if (direction === 'incoming' && !lead.source) {
    lead.source = 'Direct'
    shouldSave = true
  }

  if ((!lead.name || /^Lead\s+\d{4}$/i.test(lead.name) || /^Exotel\s+\d{4}$/i.test(lead.name)) && lead.name !== expectedName) {
    lead.name = expectedName
    shouldSave = true
  }

  if ((!lead.lastActivity || (activityAt && new Date(lead.lastActivity).getTime() < activityAt.getTime())) && activityAt) {
    lead.lastActivity = activityAt
    shouldSave = true
  }

  if ((!lead.lastActivityNote || lead.lastActivityNote.startsWith('Exotel ')) && lead.lastActivityNote !== expectedNote) {
    lead.lastActivityNote = expectedNote
    shouldSave = true
  }

  if (shouldSave) {
    await lead.save()
  }

  return lead
}

const getCursorFromUri = (uri?: string | null, key = 'After'): string | undefined => {
  if (!uri) return undefined

  const query = uri.includes('?') ? uri.split('?')[1] : uri
  const params = new URLSearchParams(query)
  const cursor = params.get(key)
  return cursor || undefined
}

const getExotelNumbers = (): Set<string> => {
  const numbers = [exotelConfig.exoPhone, ...exotelConfig.exoPhones]
    .map((value) => normalizePhone(value))
    .filter(Boolean)

  return new Set(numbers)
}

const loadActiveUsers = async (): Promise<ActiveUserLite[]> => {
  const users = await User.find({ isActive: true })
    .select('_id name email phone role callAvailabilityStatus callDeviceMode activeCallSid isActive')
    .lean()

  return users.map((user: any) => ({
    _id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    callAvailabilityStatus: user.callAvailabilityStatus || 'available',
    callDeviceMode: user.callDeviceMode || 'phone',
    activeCallSid: user.activeCallSid || null,
    isActive: user.isActive ?? true,
  }))
}

const resolveRepresentative = (
  record: ExotelBulkCall,
  users: ActiveUserLite[],
  exotelNumbers: Set<string>
): ActiveUserLite | null => {
  const fallback = users.find((user) => user.role === 'manager') || users[0] || null

  if (getDirection(record.Direction) === 'incoming') {
    return fallback
  }

  const representativePhone = normalizePhone(record.From)
  if (!representativePhone || exotelNumbers.has(representativePhone)) {
    return fallback
  }

  return (
    users.find((user) => {
      const userPhone = normalizePhone(user.phone)
      return Boolean(userPhone && userPhone === representativePhone)
    }) || fallback
  )
}

const ensureLeadForPhone = async (
  record: ExotelBulkCall,
  activityAt: Date | null
): Promise<{ lead: any; created: boolean } | null> => {
  const direction = getDirection(record.Direction)
  const phone = getLeadPhoneFromCall(record)
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) return null

  let lead = await Lead.findOne({ phone: { $regex: `${normalizedPhone}$` } }).exec()
  if (!lead) {
    lead = await Lead.findOne({ phone: normalizedPhone }).exec()
  }
  if (!lead) {
    lead = await Lead.findOne({ phone }).exec()
  }

  if (lead) {
    const updatedLead = await applyExotelLeadMetadata(lead, record, activityAt, phone, direction)
    return { lead: updatedLead, created: false }
  }

  // Do not auto-recreate leads that were explicitly deleted by a manager
  const blocked = await DeletedLeadPhone.findOne({ phone: normalizedPhone }).lean()
  if (blocked) {
    logger.info('Skipping lead auto-creation in callSync — phone is on deleted-lead blocklist', { phone: normalizedPhone })
    return null
  }

  const createdLead = await Lead.create({
    name: buildExotelLeadName(record, phone),
    phone: normalizedPhone,
    source: 'Direct',
    disposition: 'New',
    city: 'Unknown',
    lastActivity: activityAt || new Date(),
    lastActivityNote: buildExotelLeadNote(record),
    createdAt: activityAt || new Date(),
    updatedAt: activityAt || new Date(),
  })

  return { lead: createdLead, created: true }
}

const emitCallEvent = (call: any, includeNewEvent: boolean) => {
  const payload = {
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
    representativeName: call.representativeName,
    lead: call.lead,
  }

  if (includeNewEvent) {
    emitToTeam('all', 'call:new', payload)
  }

  emitToTeam('all', 'call:status_updated', payload)
}

const syncRepresentativeAvailability = async (call: any, status: LocalCallStatus) => {
  if (!call.representative) return

  const representative = await User.findById(call.representative)
    .select('name email role phone isActive callAvailabilityStatus callDeviceMode activeCallSid')
    .exec()

  if (!representative) return

  let shouldSave = false

  if (status === 'in-progress') {
    if (representative.callAvailabilityStatus !== 'in-call') {
      representative.callAvailabilityStatus = 'in-call'
      shouldSave = true
    }
    if (call.exotelCallSid && representative.activeCallSid !== call.exotelCallSid) {
      representative.activeCallSid = call.exotelCallSid
      shouldSave = true
    }
  } else if (status === 'initiated' || status === 'ringing') {
    if (call.exotelCallSid && representative.activeCallSid !== call.exotelCallSid) {
      representative.activeCallSid = call.exotelCallSid
      shouldSave = true
    }
  } else if (TERMINAL_STATUSES.has(status)) {
    if (!representative.activeCallSid || representative.activeCallSid === call.exotelCallSid) {
      if (representative.activeCallSid) {
        representative.activeCallSid = null
        shouldSave = true
      }
      if (representative.callAvailabilityStatus !== 'offline' && representative.callAvailabilityStatus !== 'available') {
        representative.callAvailabilityStatus = 'available'
        shouldSave = true
      }
    }
  }

  if (!shouldSave) return

  await representative.save()

  emitUserAvailabilityUpdate({
    id: String(representative._id),
    name: representative.name,
    email: representative.email,
    role: representative.role,
    phone: representative.phone || null,
    callAvailabilityStatus: representative.callAvailabilityStatus || 'available',
    callDeviceMode: representative.callDeviceMode || 'phone',
    activeCallSid: representative.activeCallSid || null,
    isActive: representative.isActive,
  })
}

const repairRepresentativeFromOpenCall = async (representative: any, openCall: any): Promise<boolean> => {
  const nextStatus = openCall.status === 'in-progress' ? 'in-call' : 'available'
  const nextActiveCallSid = openCall.exotelCallSid || null

  const shouldSave =
    representative.callAvailabilityStatus !== nextStatus ||
    (representative.activeCallSid || null) !== nextActiveCallSid

  if (!shouldSave) return false

  representative.callAvailabilityStatus = nextStatus
  representative.activeCallSid = nextActiveCallSid
  await representative.save()

  emitUserAvailabilityUpdate({
    id: String(representative._id),
    name: representative.name,
    email: representative.email,
    role: representative.role,
    phone: representative.phone || null,
    callAvailabilityStatus: representative.callAvailabilityStatus || 'available',
    callDeviceMode: representative.callDeviceMode || 'phone',
    activeCallSid: representative.activeCallSid || null,
    isActive: representative.isActive,
  })

  return true
}

export const reconcileRepresentativeAvailabilityStates = async (): Promise<AvailabilityReconciliationResult> => {
  const representatives = await User.find({
    isActive: true,
    $or: [
      { activeCallSid: { $ne: null } },
      { callAvailabilityStatus: 'in-call' },
    ],
  })
    .select('name email role phone isActive callAvailabilityStatus callDeviceMode activeCallSid')
    .exec()

  let repairedCount = 0

  for (const representative of representatives) {
    const openCall =
      (representative.activeCallSid
        ? await Call.findOne({ exotelCallSid: representative.activeCallSid })
            .select('status exotelCallSid representative')
            .lean()
        : null) ||
      (await Call.findOne({
        representative: representative._id,
        status: { $in: ['initiated', 'ringing', 'in-progress'] },
      })
        .sort({ updatedAt: -1, startedAt: -1 })
        .select('status exotelCallSid representative')
        .lean())

    if (openCall) {
      const repaired = await repairRepresentativeFromOpenCall(representative, openCall)
      if (repaired) repairedCount += 1
      continue
    }

    const shouldClear =
      representative.activeCallSid !== null ||
      (representative.callAvailabilityStatus || 'available') !== 'available'

    if (!shouldClear) continue

    representative.activeCallSid = null
    representative.callAvailabilityStatus = 'available'
    await representative.save()
    repairedCount += 1

    emitUserAvailabilityUpdate({
      id: String(representative._id),
      name: representative.name,
      email: representative.email,
      role: representative.role,
      phone: representative.phone || null,
      callAvailabilityStatus: 'available',
      callDeviceMode: representative.callDeviceMode || 'phone',
      activeCallSid: null,
      isActive: representative.isActive,
    })
  }

  return { repairedCount }
}

const syncSingleCallRecord = async (
  record: ExotelBulkCall,
  users: ActiveUserLite[],
  exotelNumbers: Set<string>,
  emitEvents: boolean
): Promise<'created' | 'updated' | 'unchanged'> => {
  if (!record.Sid) return 'unchanged'

  const status = normalizeStatus(record.Status)
  const outcome = mapExotelOutcome(record.Status)
  const direction = getDirection(record.Direction)
  const legState = deriveLegState(record.Status, direction)
  const duration = toDuration(record.Duration)
  const startedAt = parseExotelDate(record.StartTime || record.DateCreated)
  const endedAt = parseExotelDate(record.EndTime || null)
  const exophoneNumber = getExophoneNumberFromCall(record)

  const existingCall = await Call.findOne({ exotelCallSid: record.Sid }).exec()
  let wasCreated = false
  let hasChanges = false
  let call: any

  const resolvedLegState =
    existingCall && shouldPreserveExistingLegState(existingCall.exotelStatusRaw, legState.exotelStatusRaw)
      ? {
          exotelStatusRaw: existingCall.exotelStatusRaw || null,
          representativeLegStatus: existingCall.representativeLegStatus || null,
          customerLegStatus: existingCall.customerLegStatus || null,
          representativeAnswered: existingCall.representativeAnswered ?? null,
          customerAnswered: existingCall.customerAnswered ?? null,
        }
      : legState

  if (!existingCall) {
    const leadPhone = getLeadPhoneFromCall(record)
    const leadResult = await ensureLeadForPhone(record, startedAt)
    const representative = resolveRepresentative(record, users, exotelNumbers)

    if (!leadResult || !representative) {
      logger.warn('Skipping Exotel call sync because lead or representative could not be resolved', {
        callSid: record.Sid,
        leadPhone,
      })
      return 'unchanged'
    }
    const lead = leadResult.lead

    try {
      call = await Call.findOneAndUpdate(
        { exotelCallSid: record.Sid },
        {
          $setOnInsert: {
            lead: lead._id,
            leadName: lead.name,
            phone: lead.phone,
            representative: representative._id,
            representativeName: representative.name,
            exophoneNumber,
            exotelCallSid: record.Sid,
            exotelStatusRaw: resolvedLegState.exotelStatusRaw,
            direction,
            status,
            outcome,
            representativeLegStatus: resolvedLegState.representativeLegStatus,
            customerLegStatus: resolvedLegState.customerLegStatus,
            representativeAnswered: resolvedLegState.representativeAnswered,
            customerAnswered: resolvedLegState.customerAnswered,
            duration,
            recordingUrl: record.RecordingUrl || null,
            startedAt: startedAt || new Date(),
            endedAt,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec()

      wasCreated = true

      if (leadResult.created && emitEvents) {
        emitIncomingLeadEvent(lead)
      }
    } catch (upsertErr: any) {
      if (upsertErr?.code === 11000) {
        call = await Call.findOne({ exotelCallSid: record.Sid }).exec()
        if (!call) return 'unchanged'
      } else {
        throw upsertErr
      }
    }
  } else {
    call = existingCall

    const linkedLead = await Lead.findById(call.lead).exec()
    if (linkedLead) {
      await applyExotelLeadMetadata(
        linkedLead,
        record,
        startedAt,
        linkedLead.phone || getLeadPhoneFromCall(record),
        direction
      )
    }

    const representative = resolveRepresentative(record, users, exotelNumbers)

    if (call.status !== status) {
      call.status = status
      hasChanges = true
    }

    if ((call.exophoneNumber || null) !== (exophoneNumber || null)) {
      call.exophoneNumber = exophoneNumber
      hasChanges = true
    }

    if ((call.exotelStatusRaw || null) !== resolvedLegState.exotelStatusRaw) {
      call.exotelStatusRaw = resolvedLegState.exotelStatusRaw
      hasChanges = true
    }

    if ((call.outcome || null) !== outcome) {
      call.outcome = outcome
      hasChanges = true
    }

    if ((call.representativeLegStatus || null) !== resolvedLegState.representativeLegStatus) {
      call.representativeLegStatus = resolvedLegState.representativeLegStatus
      hasChanges = true
    }

    if ((call.customerLegStatus || null) !== resolvedLegState.customerLegStatus) {
      call.customerLegStatus = resolvedLegState.customerLegStatus
      hasChanges = true
    }

    if ((call.representativeAnswered ?? null) !== resolvedLegState.representativeAnswered) {
      call.representativeAnswered = resolvedLegState.representativeAnswered
      hasChanges = true
    }

    if ((call.customerAnswered ?? null) !== resolvedLegState.customerAnswered) {
      call.customerAnswered = resolvedLegState.customerAnswered
      hasChanges = true
    }

    if (call.direction !== direction) {
      call.direction = direction
      hasChanges = true
    }

    if ((call.duration || 0) !== duration) {
      call.duration = duration
      hasChanges = true
    }

    if ((call.recordingUrl || null) !== (record.RecordingUrl || null)) {
      call.recordingUrl = record.RecordingUrl || null
      hasChanges = true
    }

    const nextStartedAt = startedAt?.getTime() || null
    const currentStartedAt = call.startedAt?.getTime() || null
    if (nextStartedAt !== currentStartedAt) {
      call.startedAt = startedAt
      hasChanges = true
    }

    const nextEndedAt = endedAt?.getTime() || null
    const currentEndedAt = call.endedAt?.getTime() || null
    if (nextEndedAt !== currentEndedAt) {
      call.endedAt = endedAt
      hasChanges = true
    }

    if (representative && String(call.representative) !== representative._id) {
      call.representative = representative._id as any
      call.representativeName = representative.name
      hasChanges = true
    } else if (representative && call.representativeName !== representative.name) {
      call.representativeName = representative.name
      hasChanges = true
    }

    if (hasChanges) {
      await call.save()
    }
  }

  if ((wasCreated || hasChanges) && outcome === 'Connected') {
    // Only auto-advance disposition from "New" → "Contacted/Open".
    // Never overwrite dispositions that the rep already set manually
    // (e.g. Failed, Qualified, Visit Done, etc.)
    const leadForDisposition = await Lead.findById(call.lead).select('disposition').lean().exec()
    const updatePayload: Record<string, unknown> = {
      lastActivity: endedAt || startedAt || new Date(),
    }
    if (!leadForDisposition || leadForDisposition.disposition === 'New') {
      updatePayload.disposition = 'Contacted/Open'
    }
    await Lead.findByIdAndUpdate(call.lead, updatePayload).exec()
  }

  // Always sync availability for terminal statuses to prevent stuck "in-call" states
  if (wasCreated || hasChanges || TERMINAL_STATUSES.has(status)) {
    await syncRepresentativeAvailability(call, status)
  }

  if (emitEvents && (wasCreated || hasChanges)) {
    emitCallEvent(call, wasCreated)
    if (['Not Answered', 'Busy'].includes(outcome || '')) {
      void notifyMissedCall(String(call._id)).catch(() => null)
    }
  }

  if (wasCreated) return 'created'
  if (hasChanges) return 'updated'
  return 'unchanged'
}

export const syncExotelCallHistory = async (
  options: SyncExotelHistoryOptions = {}
): Promise<SyncExotelHistoryResult> => {
  const {
    after,
    dateFrom,
    dateTo,
    days,
    emitEvents = false,
    maxPages = 20,
    pageSize = 100,
    sids,
  } = options

  const result: SyncExotelHistoryResult = {
    createdCount: 0,
    fetchedCount: 0,
    pagesFetched: 0,
    unchangedCount: 0,
    updatedCount: 0,
  }

  const users = await loadActiveUsers()
  if (!users.length) {
    logger.warn('Skipping Exotel call sync because there are no active users in BuildFlow')
    return result
  }

  const exotelNumbers = getExotelNumbers()

  const endDate = dateTo || new Date()
  const startDate =
    dateFrom ||
    (days !== undefined
      ? new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000)
      : undefined)

  let cursor = after
  let page = 0

  while (page < maxPages) {
    const params: Record<string, string | number | undefined> = {
      PageSize: pageSize,
      SortBy: 'DateCreated:desc',
      After: cursor,
      Sid: sids?.length ? sids.join(',') : undefined,
      DateCreated: startDate ? `gte:${formatExotelDate(startDate)};lte:${formatExotelDate(endDate)}` : undefined,
    }

    const response = await listCalls(params)
    if (!response) {
      break
    }

    const records = response.Calls || []
    result.pagesFetched += 1
    result.fetchedCount += records.length

    if (!records.length) {
      break
    }

    for (const record of records) {
      const status = await syncSingleCallRecord(record, users, exotelNumbers, emitEvents)
      if (status === 'created') result.createdCount += 1
      else if (status === 'updated') result.updatedCount += 1
      else result.unchangedCount += 1
    }

    page += 1

    if (sids?.length) {
      break
    }

    const nextCursor = getCursorFromUri(response.Metadata?.NextPageUri)
    if (!nextCursor || nextCursor === cursor) {
      break
    }

    cursor = nextCursor
  }

  await reconcileRepresentativeAvailabilityStates()

  return result
}

export const syncRecentExotelCallHistory = async (): Promise<SyncExotelHistoryResult> => {
  const now = new Date()
  const twentySixHoursAgo = new Date(now.getTime() - 26 * 60 * 60 * 1000)

  return syncExotelCallHistory({
    dateFrom: twentySixHoursAgo,
    dateTo: now,
    emitEvents: true,
    maxPages: 20,
    pageSize: 100,
  })
}
