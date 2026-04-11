import { Request, Response, NextFunction } from 'express'
import axios from 'axios'
import { Call } from '../models/Call'
import { Lead } from '../models/Lead'
import { Reminder } from '../models/Reminder'
import { Settings } from '../models/Settings'
import { User } from '../models/User'
import { exotelConfig } from '../config/exotel'
import { emitUserAvailabilityUpdate, type UserAvailabilityPayload } from '../config/socket'
import { DISPOSITIONS } from '../config/constants'
import { syncExotelCallHistory } from '../services/callSync.service'
import { ExotelManagedCallError, getManagedCallDetails, initiateManagedCall } from '../services/exotel.service'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'
import { normalizeFeatureControls } from '../utils/featureControls'

const normalizePhone = (value?: string | null): string => {
  if (!value) return ''
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''
  const stripped = digits.replace(/^0+/, '')
  return stripped.length <= 10 ? stripped : stripped.slice(-10)
}

const toDialablePhone = (value?: string | null): string => {
  if (!value) return ''

  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''

  if (trimmed.startsWith('+') && digits.length >= 8) {
    return `+${digits}`
  }

  if (digits.length === 10) {
    return `+91${digits}`
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return `+91${digits.slice(1)}`
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`
  }

  return trimmed.startsWith('+') ? trimmed : `+${digits}`
}

const buildManualLeadName = (phone: string): string => {
  const normalized = normalizePhone(phone)
  return normalized ? `Manual ${normalized.slice(-4)}` : 'Manual Lead'
}

const normalizeDispositionInput = (value?: string | null): string | null => {
  if (!value) return null

  const trimmed = value.trim()
  if ((DISPOSITIONS as readonly string[]).includes(trimmed)) return trimmed

  const legacyMap: Record<string, string> = {
    'new-lead': 'New',
    connected: 'Contacted/Open',
    contacted: 'Contacted/Open',
    'not-contacted': 'New',
  }

  return legacyMap[trimmed.toLowerCase()] || null
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

const ensureLeadForDialerPhone = async (params: {
  phone: string
  leadName?: string
  city?: string
  ownerId?: string
  ownerName?: string
}) => {
  const normalizedPhone = normalizePhone(params.phone)
  if (!normalizedPhone) return null

  let lead =
    (await Lead.findOne({ phone: { $regex: `${normalizedPhone}$` } }).exec()) ||
    (await Lead.findOne({ phone: normalizedPhone }).exec()) ||
    (await Lead.findOne({ phone: params.phone }).exec())

  if (!lead) {
    lead = await Lead.create({
      name: params.leadName?.trim() || buildManualLeadName(normalizedPhone),
      phone: normalizedPhone,
      city: params.city?.trim() || 'Unknown',
      source: 'Manual',
      disposition: 'New',
      owner: null,
      ownerName: null,
      isInQueue: false,
      lastActivity: new Date(),
      lastActivityNote: 'Created automatically from BuildFlow dialer',
    })

    void notifyNewLeadCreated(lead).catch(() => null)
  }

  return lead
}

const getCallAccessFilter = (req: Request): Record<string, unknown> =>
  req.user!.role === 'representative' ? { representative: req.user!.id } : {}

const emitRepresentativeAvailability = (representative: {
  _id: unknown
  name: string
  role: UserAvailabilityPayload['role']
  phone?: string | null
  callAvailabilityStatus?: UserAvailabilityPayload['callAvailabilityStatus']
  callDeviceMode?: UserAvailabilityPayload['callDeviceMode'] | null
  activeCallSid?: string | null
  isActive?: boolean | null
}) => {
  const payload: UserAvailabilityPayload = {
    id: String(representative._id),
    name: representative.name,
    role: representative.role,
    phone: representative.phone ?? null,
    callAvailabilityStatus: representative.callAvailabilityStatus ?? 'available',
    callDeviceMode: representative.callDeviceMode ?? 'phone',
    activeCallSid: representative.activeCallSid ?? null,
    isActive: representative.isActive ?? true,
  }

  emitUserAvailabilityUpdate(payload)
}

const reconcileRepresentativeCallState = async (representative: any) => {
  const openStatuses = ['initiated', 'ringing', 'in-progress']
  const openCall =
    (representative.activeCallSid
      ? await Call.findOne({
          exotelCallSid: representative.activeCallSid,
          representative: representative._id,
          status: { $in: openStatuses },
        })
          .select('exotelCallSid status')
          .lean()
      : null) ||
    (await Call.findOne({
      representative: representative._id,
      status: { $in: openStatuses },
    })
      .sort({ updatedAt: -1, startedAt: -1 })
      .select('exotelCallSid status')
      .lean())

  let shouldSave = false

  if (openCall) {
    const nextAvailability = openCall.status === 'in-progress' ? 'in-call' : 'available'
    const nextActiveCallSid = openCall.exotelCallSid || null

    if (representative.callAvailabilityStatus !== nextAvailability) {
      representative.callAvailabilityStatus = nextAvailability
      shouldSave = true
    }

    if ((representative.activeCallSid || null) !== nextActiveCallSid) {
      representative.activeCallSid = nextActiveCallSid
      shouldSave = true
    }
  } else {
    if (representative.activeCallSid) {
      representative.activeCallSid = null
      shouldSave = true
    }

    if (
      representative.callAvailabilityStatus !== 'offline' &&
      representative.callAvailabilityStatus !== 'available'
    ) {
      representative.callAvailabilityStatus = 'available'
      shouldSave = true
    }
  }

  if (shouldSave) {
    await representative.save()
    emitRepresentativeAvailability(representative)
  }

  return openCall
}

/**
 * Finds every user currently marked 'in-call' and reconciles their state
 * against live call records. Any rep with no open call gets reset to 'available'.
 * Safe to call any time – it only modifies users whose state is actually wrong.
 */
export const reconcileAllStuckCallStatuses = async (): Promise<number> => {
  // Catch both 'in-call' AND users with a stale activeCallSid (shows as 'Dialing' in UI)
  const stuckUsers = await User.find({
    $or: [
      { callAvailabilityStatus: 'in-call' },
      { activeCallSid: { $ne: null } },
    ]
  }).select('name phone role isActive callAvailabilityStatus callDeviceMode activeCallSid')

  let fixed = 0
  for (const user of stuckUsers) {
    const beforeStatus = user.callAvailabilityStatus
    const beforeSid = user.activeCallSid
    await reconcileRepresentativeCallState(user)
    if (user.callAvailabilityStatus !== beforeStatus || user.activeCallSid !== beforeSid) fixed++
  }
  return fixed
}

export const resetStuckCallStatuses = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fixed = await reconcileAllStuckCallStatuses()
    return res.status(200).json({ success: true, message: `Reconciled ${fixed} stuck call status(es)`, fixed })
  } catch (err) {
    next(err)
  }
}

export const initiateCall = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leadId, phone, leadName, city, agentPhone, representativeId, recordCall } = req.body
    const settings = await Settings.findOne().lean()
    const featureControls = normalizeFeatureControls(settings?.featureControls, settings?.leadRouting?.mode)

    if (!leadId && !phone) {
      return res.status(400).json({ success: false, message: 'leadId or phone is required to place a call' })
    }

    if (!featureControls.dialer) {
      return res.status(403).json({ success: false, message: 'Dialer is disabled in Feature Controls' })
    }

    const targetRepresentativeId =
      representativeId && representativeId !== req.user!.id ? representativeId : req.user!.id

    if (targetRepresentativeId !== req.user!.id && req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Only managers can place calls on behalf of another representative' })
    }

    const representative = await User.findById(targetRepresentativeId).select(
      'name phone role isActive callAvailabilityStatus callDeviceMode activeCallSid'
    )

    if (!representative || !representative.isActive) {
      return res.status(404).json({ success: false, message: 'Representative not found or inactive' })
    }

    if (representative.callAvailabilityStatus === 'offline') {
      return res.status(409).json({ success: false, message: 'Selected representative is offline for calls' })
    }

    if (representative.callAvailabilityStatus === 'in-call' || representative.activeCallSid) {
      await reconcileRepresentativeCallState(representative)
    }

    if (representative.callAvailabilityStatus === 'in-call' || representative.activeCallSid) {
      return res.status(409).json({ success: false, message: 'Selected representative already has a live or pending call' })
    }

    const outgoingPhone = toDialablePhone(agentPhone || representative.phone || req.user!.phone)
    if (!outgoingPhone) {
      return res.status(400).json({ success: false, message: 'Representative phone number is required to place a call' })
    }

    const lead =
      (leadId ? await Lead.findById(leadId) : null) ||
      (phone
        ? await ensureLeadForDialerPhone({
            phone,
            leadName,
            city,
            ownerId: String(representative._id),
            ownerName: representative.name,
          })
        : null)

    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    const destinationPhone = toDialablePhone(lead.phone)
    if (!destinationPhone) {
      return res.status(400).json({ success: false, message: 'Lead phone number is not dialable' })
    }

    const customField = JSON.stringify({
      source: 'buildflow',
      leadId: String(lead._id),
      representativeId: String(representative._id),
    })
    const shouldRecordCall =
      featureControls.callRecording &&
      (typeof recordCall === 'boolean' ? recordCall : exotelConfig.recordingEnabled)

    const callData = await initiateManagedCall({
      from: {
        contact_uri: outgoingPhone,
        state_management: true,
      },
      to: {
        contact_uri: destinationPhone,
      },
      virtual_number: exotelConfig.exoPhone,
      attempt_time_out: 45,
      max_time_limit: 4 * 60 * 60,
      custom_field: customField,
      recording: {
        record: shouldRecordCall,
        channels: exotelConfig.recordingChannels,
      },
      status_callback: [
        {
          event: 'answered',
          url: exotelConfig.statusCallbackUrl,
          method: 'POST',
          content_type: 'application/json',
        },
        {
          event: 'terminal',
          url: exotelConfig.statusCallbackUrl,
          method: 'POST',
          content_type: 'application/json',
        },
      ],
    })

    if (!callData) {
      throw new Error('Exotel did not return call details for the initiated call')
    }

    const call = await Call.create({
      lead: lead._id,
      leadName: lead.name,
      phone: lead.phone,
      representative: representative._id,
      representativeName: representative.name,
      exophoneNumber: exotelConfig.exoPhone,
      exotelCallSid: callData.sid,
      exotelStatusRaw: 'initiated',
      status: 'initiated',
      direction: 'outbound',
      representativeLegStatus: 'dialing',
      customerLegStatus: 'waiting',
      representativeAnswered: null,
      customerAnswered: null,
      recordingRequested: shouldRecordCall,
      startedAt: callData.start_time ? new Date(callData.start_time) : new Date(),
    })

    await Promise.all([
      Lead.findByIdAndUpdate(lead._id, { lastActivity: new Date() }),
      User.findByIdAndUpdate(representative._id, {
        activeCallSid: callData.sid,
      }),
    ])

    emitRepresentativeAvailability({
      _id: representative._id,
      name: representative.name,
      role: representative.role,
      phone: representative.phone || null,
      callAvailabilityStatus: representative.callAvailabilityStatus || 'available',
      callDeviceMode: representative.callDeviceMode || 'phone',
      activeCallSid: callData.sid,
      isActive: representative.isActive,
    })

    return res.status(201).json({ success: true, data: call })
  } catch (err) {
    if (err instanceof ExotelManagedCallError) {
      const statusCode = err.httpCode && err.httpCode >= 400 && err.httpCode < 600 ? err.httpCode : 500
      return res.status(statusCode).json({ success: false, message: err.message, exotelCode: err.exotelCode })
    }
    next(err)
  }
}

export const getCalls = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = '1',
      limit = '20',
      outcome,
      direction,
      representative,
      search,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>

    const pageNum = Math.max(1, parseInt(page, 10))
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)))
    const skip = (pageNum - 1) * limitNum

    const accessFilter = getCallAccessFilter(req)
    const filter: Record<string, unknown> = {
      ...accessFilter,
      exotelCallSid: { $ne: null },
    }

    if (outcome) filter.outcome = outcome
    if (direction) filter.direction = direction
    if (representative && req.user!.role === 'manager') filter.representative = representative

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { leadName: { $regex: escaped, $options: 'i' } },
        { phone: { $regex: escaped, $options: 'i' } },
        { representativeName: { $regex: escaped, $options: 'i' } },
      ]
    }

    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {}
      if (dateFrom) dateFilter.$gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setHours(23, 59, 59, 999)
        dateFilter.$lte = end
      }
      filter.startedAt = dateFilter
    }

    const [calls, total] = await Promise.all([
      Call.find(filter)
        .sort({ startedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('lead', 'name phone city disposition')
        .lean(),
      Call.countDocuments(filter),
    ])

    const formattedCalls = calls.map((c: any) => ({
      _id: String(c._id),
      exotelCallSid: c.exotelCallSid,
      exophoneNumber: c.exophoneNumber || null,
      exotelStatusRaw: c.exotelStatusRaw || null,
      leadName: c.leadName,
      phone: c.phone,
      status: c.status,
      outcome: c.outcome || null,
      representativeLegStatus: c.representativeLegStatus || null,
      customerLegStatus: c.customerLegStatus || null,
      representativeAnswered: c.representativeAnswered ?? null,
      customerAnswered: c.customerAnswered ?? null,
      direction: c.direction,
      duration: c.duration || 0,
      recordingRequested: c.recordingRequested ?? null,
      recordingUrl: c.recordingUrl || null,
      startedAt: c.startedAt,
      endedAt: c.endedAt || null,
      representative: c.representative,
      representativeName: c.representativeName || null,
      lead: c.lead,
      createdAt: c.createdAt,
    }))

    return res.status(200).json({
      success: true,
      data: formattedCalls,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getCallById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await Call.findById(req.params.id)
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' })
    }
    if (req.user!.role === 'representative' && String(call.representative) !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'You do not have access to this call' })
    }
    return res.status(200).json({ success: true, data: call })
  } catch (err) {
    next(err)
  }
}

export const getCallsByLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: Record<string, unknown> = { lead: req.params.leadId }
    if (req.user!.role === 'representative') {
      filter.representative = req.user!.id
    }

    const calls = await Call.find(filter).sort({ startedAt: -1, createdAt: -1 })
    return res.status(200).json({ success: true, data: calls })
  } catch (err) {
    next(err)
  }
}

export const postCallFeedback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { outcome, stage, disposition, notes, nextFollowUp, followUpAt } = req.body
    const normalizedDisposition = normalizeDispositionInput(disposition || stage)
    const resolvedNextFollowUp = nextFollowUp || followUpAt || null

    const call = await Call.findById(req.params.id)
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' })
    }
    if (req.user!.role === 'representative' && String(call.representative) !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'You do not have access to this call' })
    }

    if (outcome) call.outcome = outcome
    if (normalizedDisposition) call.stage = normalizedDisposition
    if (notes !== undefined) call.notes = notes
    call.feedbackSubmittedAt = new Date()
    await call.save()

    const updatedLead = await Lead.findByIdAndUpdate(call.lead, {
      ...(normalizedDisposition && { disposition: normalizedDisposition }),
      lastActivity: new Date(),
      ...(notes !== undefined && { lastActivityNote: notes }),
      ...(resolvedNextFollowUp && { nextFollowUp: resolvedNextFollowUp }),
    }, { new: true })

    if (resolvedNextFollowUp && updatedLead) {
      await Reminder.findOneAndUpdate(
        {
          lead: updatedLead._id,
          owner: call.representative,
          status: { $ne: 'completed' },
          title: 'Call follow-up',
        },
        {
          lead: updatedLead._id,
          leadName: updatedLead.name,
          owner: call.representative,
          ownerName: call.representativeName,
          title: 'Call follow-up',
          notes: notes || 'Follow-up requested after call feedback',
          dueAt: resolvedNextFollowUp,
          priority: 'medium',
          status: 'upcoming',
        },
        { upsert: true, new: true, runValidators: true }
      )
    }

    return res.status(200).json({ success: true, data: call })
  } catch (err) {
    next(err)
  }
}

export const syncCallFromExotel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { callSid } = req.params

    const existingCall = await Call.findOne({ exotelCallSid: callSid }).exec()
    const managedCallDetails = await getManagedCallDetails(callSid)

    if (existingCall && managedCallDetails) {
      const direction = managedCallDetails.direction?.startsWith('inbound') ? 'incoming' : 'outbound'
      const rawStatus = managedCallDetails.status || (managedCallDetails.state === 'active' ? 'in-progress' : null)
      const legState = deriveLegState(rawStatus, direction)

      existingCall.exotelStatusRaw = legState.exotelStatusRaw
      existingCall.direction = direction
      existingCall.exophoneNumber = managedCallDetails.virtual_number || existingCall.exophoneNumber || null
      existingCall.representativeLegStatus = legState.representativeLegStatus
      existingCall.customerLegStatus = legState.customerLegStatus
      existingCall.representativeAnswered = legState.representativeAnswered
      existingCall.customerAnswered = legState.customerAnswered
      existingCall.duration = managedCallDetails.total_talk_time || managedCallDetails.total_duration || existingCall.duration || 0
      if (managedCallDetails.start_time) existingCall.startedAt = new Date(managedCallDetails.start_time)
      if (managedCallDetails.end_time) existingCall.endedAt = new Date(managedCallDetails.end_time)
      if (managedCallDetails.recordings?.[0]?.url) existingCall.recordingUrl = managedCallDetails.recordings[0].url
      await existingCall.save()
    }

    const syncResult = await syncExotelCallHistory({
      emitEvents: true,
      maxPages: 1,
      pageSize: 10,
      sids: [callSid],
    })

    const updated = await Call.findOne({ exotelCallSid: callSid }).lean()

    return res.status(200).json({
      success: true,
      data: updated,
      sync: syncResult,
    })
  } catch (err) {
    next(err)
  }
}

export const syncCallsFromExotel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dateFrom, dateTo, days, pageSize = '100' } = req.query as Record<string, string>

    const parsedDateFrom = dateFrom ? new Date(dateFrom) : undefined
    const parsedDateTo = dateTo ? new Date(dateTo) : undefined
    const parsedDays =
      dateFrom || !days ? undefined : Math.max(1, Math.min(30, parseInt(days, 10) || 30))
    const parsedPageSize = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 100))

    const syncResult = await syncExotelCallHistory({
      dateFrom: parsedDateFrom,
      dateTo: parsedDateTo,
      days: parsedDays,
      emitEvents: true,
      maxPages: 40,
      pageSize: parsedPageSize,
    })

    return res.status(200).json({
      success: true,
      message: `Synced ${syncResult.createdCount} new calls and updated ${syncResult.updatedCount} existing calls from Exotel`,
      ...syncResult,
    })
  } catch (err) {
    logger.error('Manual sync error:', err)
    next(err)
  }
}

export const getCallsDebug = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getCallAccessFilter(req)
    const calls = await Call.find(filter).sort({ startedAt: -1, createdAt: -1 }).lean()
    const total = await Call.countDocuments(filter)
    const withSid = await Call.countDocuments({ ...filter, exotelCallSid: { $ne: null } })
    const withoutSid = await Call.countDocuments({ ...filter, exotelCallSid: null })

    return res.status(200).json({
      success: true,
      data: calls,
      total,
      withSid,
      withoutSid,
      message: `Found ${total} calls in database (${withSid} synced from Exotel, ${withoutSid} local-only)`,
    })
  } catch (err) {
    next(err)
  }
}

export const purgeOrphanedCalls = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Only managers can run call cleanup' })
    }

    const stuckStatuses = ['initiated', 'ringing']
    const cutoffMs = 4 * 60 * 60 * 1000
    const cutoffDate = new Date(Date.now() - cutoffMs)

    const orphanedResult = await Call.deleteMany({
      exotelCallSid: null,
      status: { $in: stuckStatuses },
      createdAt: { $lt: cutoffDate },
    })

    const allSids = await Call.distinct('exotelCallSid', { exotelCallSid: { $ne: null } })
    let deduplicatedCount = 0

    for (const sid of allSids) {
      const dupes = await Call.find({ exotelCallSid: sid })
        .sort({ createdAt: 1 })
        .select('_id')
        .lean()

      if (dupes.length > 1) {
        const idsToRemove = dupes.slice(1).map((d) => d._id)
        await Call.deleteMany({ _id: { $in: idsToRemove } })
        deduplicatedCount += idsToRemove.length
      }
    }

    return res.status(200).json({
      success: true,
      message: `Removed ${orphanedResult.deletedCount} orphaned local-only calls and ${deduplicatedCount} duplicate SID calls`,
      orphanedRemoved: orphanedResult.deletedCount,
      duplicatesRemoved: deduplicatedCount,
    })
  } catch (err) {
    next(err)
  }
}

export const getCallRecording = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
    const settings = await Settings.findOne().lean()
    const featureControls = normalizeFeatureControls(settings?.featureControls, settings?.leadRouting?.mode)

    if (!featureControls.callRecording) {
      return res.status(403).json({ success: false, message: 'Call recordings are disabled in Feature Controls' })
    }

    let call = await Call.findById(id).exec()
    if (!call) {
      call = await Call.findOne({ exotelCallSid: id }).exec()
    }

    if (call && req.user!.role === 'representative' && String(call.representative) !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'You do not have access to this call' })
    }

    const exotelCallSid = call?.exotelCallSid || id

    let recordingUrl = call?.recordingUrl || null
    if (!recordingUrl) {
      const exotelRes = await axios.get(`${exotelConfig.baseUrl}/Calls/${exotelCallSid}.json`)
      recordingUrl = exotelRes.data?.Call?.RecordingUrl || null
    }

    if (!recordingUrl) {
      return res.status(404).json({ success: false, message: 'Recording URL not found in Exotel or DB' })
    }

    const axiosHeaders: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${exotelConfig.apiKey}:${exotelConfig.apiToken}`).toString('base64')}`,
    }

    if (req.headers.range) {
      axiosHeaders.Range = req.headers.range
    }

    const response = await axios.get(recordingUrl, {
      responseType: 'stream',
      headers: axiosHeaders,
    })

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', response.headers['content-type'] || 'audio/mpeg')
    res.setHeader('Accept-Ranges', 'bytes')

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length'])
    }

    if (response.headers['content-range']) {
      res.setHeader('Content-Range', response.headers['content-range'])
      res.status(206)
    }

    response.data.pipe(res)
  } catch (err: any) {
    logger.error('Error proxying recording', { message: err?.message })
    res.status(500).json({ success: false, message: 'Failed to fetch recording from Exotel' })
  }
}
