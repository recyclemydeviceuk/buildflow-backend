import { Request, Response, NextFunction } from 'express'
import mongoose from 'mongoose'
import { Lead } from '../models/Lead'
import { User } from '../models/User'
import { AuditLog } from '../models/AuditLog'
import { emitToTeam } from '../config/socket'
import { QueueItem } from '../models/QueueItem'
import { Reminder } from '../models/Reminder'
import { Call } from '../models/Call'
import { FollowUp } from '../models/FollowUp'
import { DeletedLeadPhone } from '../models/DeletedLeadPhone'
import { DeletedLeadExternalId } from '../models/DeletedLeadExternalId'
import { LEAD_SOURCES } from '../config/constants'
import { Settings } from '../models/Settings'
import { sendLeadAssignedEmail } from '../services/ses.service'
import { notifyNewLeadCreated } from '../services/notification.service'
import { routeLead } from '../services/leadRouting.service'
import { computeReminderStatus } from '../services/reminder.service'
import { normalizeNotificationPrefs } from '../utils/notificationPrefs'
import { normalizeLeadFields, type LeadFieldDefinition, type LeadFieldKey } from '../utils/leadFields'
import { parseImportFile } from '../utils/csvParser'
import { isValid, parse as parseDate, parseISO } from 'date-fns'

const DISPOSITIONS = ['New', 'Contacted/Open', 'Qualified', 'Visit Done', 'Meeting Done', 'Negotiation Done', 'Booking Done', 'Agreement Done', 'Failed']
const FAILED_REASONS = ['Budget Issue', 'Not Interested', 'Location Issue', 'Timeline Issue', 'Competition', 'Not Responding', 'Not Enquired', 'Invalid Number', 'Other']
const MEETING_TYPES = ['VC', 'Client Place']
type BulkLeadUpdatePayload = {
  source?: string
  disposition?: string
  owner?: string | null
  ownerName?: string | null
  assignedAt?: Date | null
  isInQueue?: boolean
  createdAt?: Date
}

const IMPORT_EXTRA_FIELDS = ['source', 'disposition', 'notes', 'ownerName', 'nextFollowUp', 'receivedDate', 'meetingType', 'meetingLocation', 'failedReason', 'alternatePhone'] as const
type ImportExtraField = (typeof IMPORT_EXTRA_FIELDS)[number]
type ImportTargetField = LeadFieldKey | ImportExtraField | 'skip'

const normalizeComparator = (value?: string | null): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

const FIELD_ALIASES: Record<LeadFieldKey | ImportExtraField, string[]> = {
  name: ['name', 'fullname', 'full name', 'contactname', 'contact name', 'leadname'],
  phone: ['phone', 'phonenumber', 'phone number', 'mobile', 'mobile number', 'contact', 'contact number'],
  city: ['city', 'location', 'place'],
  email: ['email', 'email address', 'mail'],
  budget: ['budget', 'price', 'investment', 'budget range'],
  buildType: ['buildtype', 'build type', 'property type', 'construction type'],
  plotOwned: ['plotowned', 'plot owned', 'ownership', 'plot ownership', 'owns plot'],
  campaign: ['campaign', 'campaign name', 'utm campaign', 'utm_campaign'],
  plotSize: ['plotsize', 'plot size', 'size', 'area'],
  plotSizeUnit: ['plotsizeunit', 'plot size unit', 'size unit', 'area unit', 'unit'],
  ownerName: ['handledby', 'handled by', 'executive', 'representative', 'representative name', 'executive name', 'assigned to', 'owner'],
  source: ['source', 'lead source', 'channel', 'utm source', 'utm_source'],
  disposition: ['disposition', 'stage', 'status', 'lead status'],
  nextFollowUp: ['followup', 'follow up', 'folow up', 'next follow up', 'nextfollowup', 'follow-up'],
  receivedDate: ['leadreceiveddate', 'lead received date', 'received date', 'lead date', 'created date'],
  notes: ['note', 'notes', 'remark', 'remarks', 'comment', 'comments', 'description', 'requirements', 'requirement', 'not qualified reason', 'notqualifiedreason'],
  meetingType: ['meetingtype', 'meeting type', 'meeting mode', 'meeting via'],
  meetingLocation: ['meetinglocation', 'meeting location', 'meeting place', 'client location', 'client address', 'visit location'],
  failedReason: ['failedreason', 'failed reason', 'lost reason', 'failure reason', 'reason for failure', 'reason for loss', 'reason lost', 'disqualified reason'],
  alternatePhone: ['alternatephone', 'alternate phone', 'alternate number', 'alt phone', 'alt number', 'secondary phone', 'secondary number', 'other phone', 'other number', 'phone2', 'mobile2'],
}

const normalizePhone = (value?: string | null): string => {
  if (!value) return ''
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''
  const stripped = digits.replace(/^0+/, '')
  return stripped.length <= 10 ? stripped : stripped.slice(-10)
}

const normalizeEmail = (value?: string | null): string =>
  String(value || '')
    .trim()
    .toLowerCase()

type RepresentativeLookupValue = {
  _id: mongoose.Types.ObjectId
  name: string
  email?: string | null
  phone?: string | null
}

type RepresentativeLookupIndexes = {
  byName: Map<string, RepresentativeLookupValue>
  byEmail: Map<string, RepresentativeLookupValue>
  byPhone: Map<string, RepresentativeLookupValue>
}

type RepresentativePreviewItem = {
  rawValue: string
  matched: boolean
  matchedBy: 'name' | 'email' | 'phone' | null
  representative: {
    id: string
    name: string
    email: string | null
    phone: string | null
  } | null
  rowNumbers: number[]
}

const buildStatusNote = (status: string, note: string, req: Request) => ({
  status,
  note,
  createdAt: new Date(),
  createdBy: new mongoose.Types.ObjectId(req.user!.id),
  createdByName: req.user!.name,
})

const syncLatestLeadNote = (lead: any) => {
  const allNotes = [...(lead.statusNotes || [])].sort(
    (a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt)
  )

  const latest = allNotes[0]
  lead.notes = latest?.note || null
  lead.lastActivityNote = latest?.note || null
  lead.lastActivity = new Date()
}

const hasMeaningfulValue = (value: unknown): boolean => String(value ?? '').trim().length > 0

const parseImportJson = <T>(value: unknown, fallback: T): T => {
  if (!value) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  if (typeof value === 'object') {
    return value as T
  }
  return fallback
}

const resolveOptionValue = (value: string, options?: string[]): string => {
  if (!options?.length) return value.trim()
  const normalizedValue = normalizeComparator(value)
  const matchedOption = options.find((option) => normalizeComparator(option) === normalizedValue)
  return matchedOption || value.trim()
}

const hasTimeComponent = (value: string): boolean => /(\d{1,2}:\d{2})|([ap]m)/i.test(value)

const applyDefaultTime = (date: Date, defaultHours = 0, defaultMinutes = 0) => {
  const nextDate = new Date(date)
  nextDate.setHours(defaultHours, defaultMinutes, 0, 0)
  return nextDate
}

const parseImportedDate = (
  value?: string | null,
  options?: { defaultHours?: number; defaultMinutes?: number }
): Date | null => {
  if (!value) return null

  const trimmedValue = String(value).trim()
  if (!trimmedValue) return null

  const numericValue = Number(trimmedValue)
  if (Number.isFinite(numericValue) && trimmedValue.length >= 4) {
    const excelEpoch = Date.UTC(1899, 11, 30)
    const parsedExcelDate = new Date(excelEpoch + numericValue * 24 * 60 * 60 * 1000)
    if (isValid(parsedExcelDate)) {
      return hasTimeComponent(trimmedValue)
        ? parsedExcelDate
        : applyDefaultTime(parsedExcelDate, options?.defaultHours, options?.defaultMinutes)
    }
  }

  const attempts = [
    () => parseISO(trimmedValue),
    () => new Date(trimmedValue),
    () => parseDate(trimmedValue, 'dd/MM/yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'd/M/yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'dd/MM/yyyy', new Date()),
    () => parseDate(trimmedValue, 'd/M/yyyy', new Date()),
    () => parseDate(trimmedValue, 'dd-MM-yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'd-M-yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'dd-MM-yyyy', new Date()),
    () => parseDate(trimmedValue, 'd-M-yyyy', new Date()),
    () => parseDate(trimmedValue, 'MM/dd/yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'M/d/yyyy HH:mm', new Date()),
    () => parseDate(trimmedValue, 'MM/dd/yyyy', new Date()),
    () => parseDate(trimmedValue, 'M/d/yyyy', new Date()),
    () => parseDate(trimmedValue, 'yyyy-MM-dd HH:mm', new Date()),
    () => parseDate(trimmedValue, "yyyy-MM-dd'T'HH:mm", new Date()),
    () => parseDate(trimmedValue, 'yyyy-MM-dd', new Date()),
  ]

  for (const attempt of attempts) {
    const parsedDate = attempt()
    if (isValid(parsedDate)) {
      return hasTimeComponent(trimmedValue)
        ? parsedDate
        : applyDefaultTime(parsedDate, options?.defaultHours, options?.defaultMinutes)
    }
  }

  return null
}

const parseRequestedCreatedAt = (value: unknown): Date | undefined => {
  if (value === undefined) return undefined

  if (value instanceof Date) {
    if (isValid(value)) return value
    throw new Error('Created at date and time is invalid')
  }

  if (typeof value === 'number') {
    const parsedDate = new Date(value)
    if (isValid(parsedDate)) return parsedDate
    throw new Error('Created at date and time is invalid')
  }

  const trimmedValue = String(value ?? '').trim()
  if (!trimmedValue) {
    throw new Error('Created at date and time is required')
  }

  const parsedDate = parseImportedDate(trimmedValue, { defaultHours: 0, defaultMinutes: 0 })
  if (!parsedDate) {
    throw new Error('Created at date and time is invalid')
  }

  return parsedDate
}

const parseImportBoolean = (value: string): boolean | null => {
  const normalizedValue = normalizeComparator(value)

  if (['true', 'yes', '1', 'owned', 'own', 'y'].includes(normalizedValue)) return true
  if (['false', 'no', '0', 'notowned', 'notown', 'n'].includes(normalizedValue)) return false

  return null
}

const parseImportNumber = (value: string): number | null => {
  const numericValue = Number.parseFloat(value.replace(/,/g, '').trim())
  return Number.isFinite(numericValue) ? numericValue : null
}

const resolvePlotSizeUnit = (value: string, allowedUnits: string[], defaultUnit?: string | null): string | null => {
  const normalizedValue = normalizeComparator(value)

  const aliases: Array<{ unit: string; matchers: string[] }> = allowedUnits.map((unit) => ({
    unit,
    matchers: [unit],
  }))

  for (const entry of aliases) {
    const normalizedMatchers = entry.matchers.map((matcher) => normalizeComparator(matcher))
    if (normalizedMatchers.some((matcher) => matcher && normalizedValue.includes(matcher))) {
      return entry.unit
    }
  }

  if (normalizedValue.includes('sqft') || normalizedValue.includes('squarefeet') || normalizedValue.includes('squarefoot')) {
    return allowedUnits.find((unit) => normalizeComparator(unit) === 'sqft') || 'sq ft'
  }
  if (normalizedValue.includes('sqyd') || normalizedValue.includes('sqyard') || normalizedValue.includes('squareyard')) {
    return allowedUnits.find((unit) => normalizeComparator(unit) === 'sqyards') || 'sq yards'
  }
  if (normalizedValue.includes('acre')) {
    return allowedUnits.find((unit) => normalizeComparator(unit) === 'acres') || 'acres'
  }
  if (normalizedValue.includes('gunta') || normalizedValue.includes('guntha')) {
    return allowedUnits.find((unit) => ['gunta', 'guntha'].includes(normalizeComparator(unit))) || 'guntha'
  }

  return defaultUnit?.trim() || null
}

const parsePlotSizeDetails = (
  value: string,
  allowedUnits: string[],
  defaultUnit?: string | null
): { size: number | null; unit: string | null } => {
  const numericMatch = String(value).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  const size = numericMatch ? Number.parseFloat(numericMatch[1]) : Number.NaN

  return {
    size: Number.isFinite(size) ? size : null,
    unit: resolvePlotSizeUnit(value, allowedUnits, defaultUnit),
  }
}

const resolveDisposition = (value?: string | null): string => {
  if (!value) return 'New'
  const normalizedValue = normalizeComparator(value)
  const aliases: Record<string, string> = {
    contacted: 'Contacted/Open',
    open: 'Contacted/Open',
    contactedopen: 'Contacted/Open',
    followup: 'Contacted/Open',
    followupdone: 'Contacted/Open',
    visitdone: 'Visit Done',
    visited: 'Visit Done',
    sitevisit: 'Visit Done',
    sitevisitdone: 'Visit Done',
    meetingdone: 'Meeting Done',
    meeting: 'Meeting Done',
    negotiationdone: 'Negotiation Done',
    negotiation: 'Negotiation Done',
    bookingdone: 'Booking Done',
    booked: 'Booking Done',
    booking: 'Booking Done',
    agreementdone: 'Agreement Done',
    agreement: 'Agreement Done',
    won: 'Agreement Done',
    closedwon: 'Agreement Done',
    failed: 'Failed',
    lost: 'Failed',
    closedlost: 'Failed',
    notinterested: 'Failed',
    notqualified: 'Failed',
    invalid: 'Failed',
    proposalsent: 'Negotiation Done',
  }
  const aliasedDisposition = aliases[normalizedValue]
  if (aliasedDisposition) return aliasedDisposition
  const matchedDisposition = DISPOSITIONS.find(
    (disposition) => normalizeComparator(disposition) === normalizedValue
  )

  return matchedDisposition || 'New'
}

const resolveSource = (value?: string | null): string => {
  if (!value) return 'Manual'
  const normalizedValue = normalizeComparator(value)
  const matchedSource = LEAD_SOURCES.find((source) => normalizeComparator(source) === normalizedValue)
  return matchedSource || String(value).trim() || 'Manual'
}

const resolveBulkLeadOwner = async (
  req: Request,
  rawOwner: unknown
): Promise<Pick<BulkLeadUpdatePayload, 'owner' | 'ownerName' | 'assignedAt' | 'isInQueue'>> => {
  if (rawOwner === null || rawOwner === undefined || rawOwner === '' || rawOwner === 'unassigned') {
    if (req.user!.role !== 'manager') {
      throw new Error('Only managers can unassign leads in bulk')
    }

    return {
      owner: null,
      ownerName: null,
      assignedAt: null,
      isInQueue: false,
    }
  }

  if (!mongoose.Types.ObjectId.isValid(String(rawOwner))) {
    throw new Error('Representative not found')
  }

  const representative = await User.findOne({ _id: rawOwner, role: 'representative', isActive: true }).select('name')
  if (!representative) {
    throw new Error('Representative not found')
  }

  return {
    owner: String(representative._id),
    ownerName: representative.name,
    assignedAt: new Date(),
    isInQueue: false,
  }
}

const suggestImportField = (
  header: string,
  availableFields: LeadFieldDefinition[]
): ImportTargetField => {
  const normalizedHeader = normalizeComparator(header)
  const availableKeys = new Set<ImportTargetField>([
    ...availableFields.map((field) => field.key),
    ...IMPORT_EXTRA_FIELDS,
  ])

  for (const field of availableFields) {
    const candidates = [
      field.key,
      field.label,
      field.placeholder || '',
      ...(FIELD_ALIASES[field.key] || []),
    ]

    if (candidates.some((candidate) => normalizeComparator(candidate) === normalizedHeader)) {
      return field.key
    }
  }

  for (const extraField of IMPORT_EXTRA_FIELDS) {
    if (!availableKeys.has(extraField)) continue

    const candidates = [extraField, ...(FIELD_ALIASES[extraField] || [])]
    if (candidates.some((candidate) => normalizeComparator(candidate) === normalizedHeader)) {
      return extraField
    }
  }

  return 'skip'
}

const buildImportedStatusNote = (status: string, note: string, req: Request) => ({
  status,
  note,
  createdAt: new Date(),
  createdBy: new mongoose.Types.ObjectId(req.user!.id),
  createdByName: req.user!.name,
})

const formatImportedNoteValue = (header: string, value: string, alwaysLabel = false) => {
  const trimmedValue = String(value).trim()
  if (!trimmedValue) return ''

  const cleanedHeader = String(header).trim()
  const normalizedHeader = normalizeComparator(cleanedHeader)

  if (!alwaysLabel && ['notes', 'note', 'remark', 'remarks', 'comment', 'comments'].includes(normalizedHeader)) {
    return trimmedValue
  }

  return `${cleanedHeader}: ${trimmedValue}`
}

const buildRepresentativeLookupIndexes = (
  representatives: RepresentativeLookupValue[]
): RepresentativeLookupIndexes => ({
  byName: new Map(
    representatives.map((representative) => [
      normalizeComparator(representative.name),
      representative,
    ])
  ),
  byEmail: new Map(
    representatives
      .filter((representative) => hasMeaningfulValue(representative.email))
      .map((representative) => [normalizeEmail(representative.email), representative])
  ),
  byPhone: new Map(
    representatives
      .filter((representative) => hasMeaningfulValue(representative.phone))
      .map((representative) => [normalizePhone(representative.phone), representative])
  ),
})

const resolveRepresentativeAssignment = (
  rawValue: string | undefined,
  representativeIndexes: RepresentativeLookupIndexes
) => {
  const trimmedValue = String(rawValue || '').trim()
  if (!trimmedValue) {
    return { representative: null, warning: null as string | null, matchedBy: null as 'name' | 'email' | 'phone' | null }
  }

  const exactEmailMatch = trimmedValue.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null
  if (exactEmailMatch) {
    const representativeByEmail = representativeIndexes.byEmail.get(normalizeEmail(exactEmailMatch)) || null
    if (representativeByEmail) {
      return { representative: representativeByEmail, warning: null as string | null, matchedBy: 'email' as const }
    }
  }

  const exactPhoneMatch = trimmedValue.match(/(?:\+?\d[\d\s()-]{7,}\d)/)?.[0] || null
  if (exactPhoneMatch) {
    const representativeByPhone = representativeIndexes.byPhone.get(normalizePhone(exactPhoneMatch)) || null
    if (representativeByPhone) {
      return { representative: representativeByPhone, warning: null as string | null, matchedBy: 'phone' as const }
    }
  }

  const representative = representativeIndexes.byName.get(normalizeComparator(trimmedValue)) || null
  if (representative) {
    return { representative, warning: null as string | null, matchedBy: 'name' as const }
  }

  return {
    representative: null,
    warning: `Representative "${trimmedValue}" was not found. Lead stayed unassigned.`,
    matchedBy: null as 'name' | 'email' | 'phone' | null,
  }
}

const buildRepresentativePreview = (params: {
  rows: Record<string, string>[]
  mappings: Record<string, ImportTargetField>
  representativeIndexes: RepresentativeLookupIndexes
  sampleLimit?: number
}) => {
  const ownerHeaders = Object.entries(params.mappings)
    .filter(([, target]) => target === 'ownerName')
    .map(([header]) => header)

  if (!ownerHeaders.length) {
    return null
  }

  const previewMap = new Map<string, RepresentativePreviewItem>()

  for (const [index, row] of params.rows.entries()) {
    for (const header of ownerHeaders) {
      const rawValue = String(row[header] || '').trim()
      if (!rawValue) continue

      const existing = previewMap.get(rawValue)
      if (existing) {
        if (existing.rowNumbers.length < 3) {
          existing.rowNumbers.push(index + 2)
        }
        continue
      }

      const resolved = resolveRepresentativeAssignment(rawValue, params.representativeIndexes)
      previewMap.set(rawValue, {
        rawValue,
        matched: Boolean(resolved.representative),
        matchedBy: resolved.matchedBy,
        representative: resolved.representative
          ? {
              id: String(resolved.representative._id),
              name: resolved.representative.name,
              email: resolved.representative.email || null,
              phone: resolved.representative.phone || null,
            }
          : null,
        rowNumbers: [index + 2],
      })
    }
  }

  const items = [...previewMap.values()]
  const matchedItems = items.filter((item) => item.matched)
  const unmatchedItems = items.filter((item) => !item.matched)

  return {
    ownerHeaders,
    rowsWithRepresentative: items.reduce((count, item) => count + item.rowNumbers.length, 0),
    uniqueRepresentativeValues: items.length,
    matchedCount: matchedItems.length,
    unmatchedCount: unmatchedItems.length,
    samples: items.slice(0, params.sampleLimit || 6),
  }
}

const syncImportedFollowUpReminder = async (params: {
  leadId: mongoose.Types.ObjectId | string
  leadName: string
  ownerId?: mongoose.Types.ObjectId | string | null
  ownerName?: string | null
  dueAt?: Date | null
  notes?: string | null
}) => {
  const { leadId, leadName, ownerId, ownerName, dueAt, notes } = params

  if (!dueAt || !ownerId || !ownerName) {
    await Reminder.deleteMany({
      lead: leadId,
      title: 'Imported follow-up',
      status: { $ne: 'completed' },
    })
    return
  }

  await Reminder.findOneAndUpdate(
    {
      lead: leadId,
      owner: ownerId,
      status: { $ne: 'completed' },
      title: 'Imported follow-up',
    },
    {
      lead: leadId,
      leadName,
      owner: ownerId,
      ownerName,
      title: 'Imported follow-up',
      notes: notes || 'Follow-up imported from lead sheet',
      dueAt,
      priority: 'medium',
      status: computeReminderStatus(dueAt),
      lastEmailNotificationStatus: null,
      lastEmailNotificationAt: null,
    },
    { upsert: true, new: true, runValidators: true }
  )
}

const coerceImportedLeadFieldValue = (
  field: LeadFieldDefinition,
  rawValue: string | undefined,
  cities: string[]
): { value?: unknown; error?: string } => {
  if (!hasMeaningfulValue(rawValue)) {
    return {}
  }

  const trimmedValue = String(rawValue).trim()

  switch (field.type) {
    case 'email':
      return { value: trimmedValue.toLowerCase() }
    case 'number': {
      const parsedValue = parseImportNumber(trimmedValue)
      if (parsedValue === null) {
        return { error: `${field.label} must be a number` }
      }
      return { value: parsedValue }
    }
    case 'boolean': {
      const parsedValue = parseImportBoolean(trimmedValue)
      if (parsedValue === null) {
        return { error: `${field.label} must be Yes/No or True/False` }
      }
      return { value: parsedValue }
    }
    case 'select':
      if (field.key === 'city') {
        return { value: resolveOptionValue(trimmedValue, cities) }
      }
      return { value: resolveOptionValue(trimmedValue, field.options) }
    default:
      return { value: trimmedValue }
  }
}

const canAccessLead = (req: Request, lead: any): boolean => {
  if (req.user!.role === 'manager') return true
  return Boolean(lead.owner && String(lead.owner) === String(req.user!.id))
}

const normalizePhoneForBlocklist = (phone?: string | null): string => {
  if (!phone) return ''
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '')
  return digits.length <= 10 ? digits : digits.slice(-10)
}

const blockDeletedPhones = async (phones: string[]): Promise<void> => {
  const normalized = [...new Set(phones.map(normalizePhoneForBlocklist).filter(Boolean))]
  if (!normalized.length) return
  await DeletedLeadPhone.bulkWrite(
    normalized.map((phone) => ({
      updateOne: {
        filter: { phone },
        update: { $set: { phone, deletedAt: new Date() } },
        upsert: true,
      },
    }))
  )
}

const blockDeletedExternalIds = async (
  entries: Array<{ externalId?: string | null; source?: string | null }>
): Promise<void> => {
  const unique = new Map<string, string | null>()
  for (const entry of entries) {
    const id = (entry.externalId || '').trim()
    if (!id) continue
    if (!unique.has(id)) unique.set(id, entry.source || null)
  }
  if (!unique.size) return
  await DeletedLeadExternalId.bulkWrite(
    Array.from(unique.entries()).map(([externalId, source]) => ({
      updateOne: {
        filter: { externalId },
        update: { $set: { externalId, source, deletedAt: new Date() } },
        upsert: true,
      },
    }))
  )
}

const buildBulkUpdateDoc = (
  lead: any,
  payload: BulkLeadUpdatePayload,
  options: { dispositionNote?: string; req: Request }
): Record<string, unknown> => {
  const $set: Record<string, unknown> = {}

  if (payload.source !== undefined) {
    $set.source = payload.source
  }

  if (payload.owner !== undefined) {
    $set.owner = payload.owner ? new mongoose.Types.ObjectId(payload.owner) : null
    $set.ownerName = payload.ownerName ?? null
    $set.assignedAt = payload.assignedAt ?? null
    $set.isInQueue = payload.isInQueue ?? false
    // Require acknowledgement when assigning to someone; clear it on unassign
    $set.assignmentAcknowledged = payload.owner ? false : true
  }

  if (payload.disposition !== undefined) {
    $set.disposition = payload.disposition
    $set.lastActivity = new Date()
    $set.lastActivityNote = options.dispositionNote || null
    $set.notes = options.dispositionNote || null
  }

  if (payload.createdAt !== undefined) {
    $set.createdAt = payload.createdAt
  }

  const update: Record<string, unknown> = { $set }

  if (payload.disposition !== undefined && options.dispositionNote) {
    update.$push = {
      statusNotes: buildStatusNote(payload.disposition, options.dispositionNote, options.req),
    }
  }

  return update
}

const deleteLeadDependencies = async (leadIds: mongoose.Types.ObjectId[]) => {
  if (!leadIds.length) return

  await Promise.all([
    Reminder.deleteMany({ lead: { $in: leadIds } }),
    QueueItem.deleteMany({ leadId: { $in: leadIds } }),
    Call.deleteMany({ lead: { $in: leadIds } }),
    FollowUp.deleteMany({ lead: { $in: leadIds } }),
  ])
}

export const previewLeadImport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Import file is required' })
    }

    const [settings] = await Promise.all([Settings.findOne({}, 'leadFields cities')])
    const normalizedLeadFields = normalizeLeadFields(settings?.leadFields)
    const activeFields = normalizedLeadFields.fields.filter((field) => field.active)
    const parsedFile = parseImportFile(req.file.buffer, req.file.originalname)
    const rawMappings = parseImportJson<Record<string, string>>(req.body?.mappings, {})
    const allowedTargets = new Set<string>([
      ...activeFields.map((field) => field.key),
      ...IMPORT_EXTRA_FIELDS,
      'skip',
    ])
    const mappings = Object.entries(rawMappings).reduce<Record<string, ImportTargetField>>((accumulator, [header, target]) => {
      if (!parsedFile.headers.includes(header)) return accumulator
      accumulator[header] = allowedTargets.has(target) ? (target as ImportTargetField) : 'skip'
      return accumulator
    }, {})
    const suggestedMappings = parsedFile.headers.reduce<Record<string, ImportTargetField>>((accumulator, header) => {
      accumulator[header] = suggestImportField(header, activeFields)
      return accumulator
    }, {})
    const representativePreview =
      req.user!.role === 'manager' && Object.values(mappings).includes('ownerName')
        ? buildRepresentativePreview({
            rows: parsedFile.rows,
            mappings,
            representativeIndexes: buildRepresentativeLookupIndexes(
              await User.find({ role: 'representative', isActive: true }).select('name email phone') as RepresentativeLookupValue[]
            ),
          })
        : null

    return res.status(200).json({
      success: true,
      data: {
        fileName: req.file.originalname,
        rowCount: parsedFile.rows.length,
        headers: parsedFile.headers,
        previewRows: parsedFile.rows.slice(0, 5),
        requiredFields: activeFields.filter((field) => field.required).map((field) => field.key),
        leadFields: activeFields,
        extraFields: IMPORT_EXTRA_FIELDS,
        suggestedMappings,
        dispositions: DISPOSITIONS,
        cities: settings?.cities || [],
        representativePreview,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const bulkUpdateLeads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedIds: string[] = Array.isArray(req.body?.ids)
      ? Array.from(new Set<string>(req.body.ids.map((id: unknown) => String(id)).filter(Boolean)))
      : []

    if (!requestedIds.length) {
      return res.status(400).json({ success: false, message: 'Select at least one lead to update' })
    }

    const bulkPayload: BulkLeadUpdatePayload = {}
    const nextDisposition = req.body?.disposition && DISPOSITIONS.includes(req.body.disposition)
      ? req.body.disposition
      : undefined
    const nextSource = typeof req.body?.source === 'string' && req.body.source.trim()
      ? resolveSource(req.body.source)
      : undefined
    const rawOwner = req.body?.owner
    const dispositionNote = typeof req.body?.statusNote === 'string' ? req.body.statusNote.trim() : ''
    let nextCreatedAt: Date | undefined

    if (nextSource) {
      bulkPayload.source = nextSource
    }

    if (nextDisposition) {
      if (!dispositionNote) {
        return res.status(400).json({ success: false, message: 'A note is required whenever you change the lead status' })
      }
      bulkPayload.disposition = nextDisposition
    }

    if (rawOwner !== undefined) {
      try {
        Object.assign(bulkPayload, await resolveBulkLeadOwner(req, rawOwner))
      } catch (error: any) {
        const message = error instanceof Error ? error.message : 'Failed to resolve representative'
        const statusCode = message === 'Representative not found' ? 404 : 403
        return res.status(statusCode).json({ success: false, message })
      }
    }

    if (req.body?.createdAt !== undefined) {
      try {
        nextCreatedAt = parseRequestedCreatedAt(req.body.createdAt)
      } catch (error: any) {
        return res.status(400).json({
          success: false,
          message: error instanceof Error ? error.message : 'Created at date and time is invalid',
        })
      }
    }

    if (nextCreatedAt) {
      bulkPayload.createdAt = nextCreatedAt
    }

    if (!Object.keys(bulkPayload).length) {
      return res.status(400).json({ success: false, message: 'Choose at least one bulk edit action' })
    }

    const leads = await Lead.find({ _id: { $in: requestedIds } })
    const accessibleLeads = leads.filter((lead) => canAccessLead(req, lead))
    const skippedIds = requestedIds.filter((id) => !accessibleLeads.some((lead) => String(lead._id) === id))

    if (!accessibleLeads.length) {
      return res.status(403).json({ success: false, message: 'You do not have access to update the selected leads' })
    }

    const updatedIds: string[] = []
    const auditEntries: Array<Record<string, unknown>> = []

    for (const lead of accessibleLeads) {
      const before = lead.toObject()
      const updateDoc = buildBulkUpdateDoc(lead, bulkPayload, { dispositionNote, req })
      const { $set, $push } = updateDoc as any
      const rawUpdate: Record<string, unknown> = { $set: { ...$set, updatedAt: new Date() } }
      if ($push) rawUpdate.$push = $push
      await Lead.collection.updateOne({ _id: lead._id }, rawUpdate)
      const after = await Lead.findById(lead._id)
      updatedIds.push(String(lead._id))
      auditEntries.push({
        actor: req.user!.id,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        action: 'lead.bulk_updated',
        entity: 'Lead',
        entityId: String(lead._id),
        before,
        after: after?.toObject(),
      })
    }

    if (bulkPayload.owner !== undefined) {
      await QueueItem.deleteMany({ leadId: { $in: accessibleLeads.map((lead) => lead._id) } })
      emitToTeam('all', 'lead:assigned', {
        leadIds: updatedIds,
        assignedTo: bulkPayload.owner || null,
        assignedToName: bulkPayload.ownerName || null,
      })
    } else {
      emitToTeam('all', 'lead:incoming', {
        updated: {
          leadIds: updatedIds,
        },
      })
    }

    if (auditEntries.length) {
      await AuditLog.insertMany(auditEntries)
    }

    return res.status(200).json({
      success: true,
      message:
        updatedIds.length === 1
          ? '1 lead updated successfully'
          : `${updatedIds.length} leads updated successfully`,
      data: {
        updatedIds,
        updatedCount: updatedIds.length,
        skippedIds,
        skippedCount: skippedIds.length,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const importLeadsFromFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Import file is required' })
    }

    const [settings] = await Promise.all([Settings.findOne({}, 'leadFields cities')])
    const normalizedLeadFields = normalizeLeadFields(settings?.leadFields)
    const activeFields = normalizedLeadFields.fields.filter((field) => field.active)
    const cities = Array.isArray(settings?.cities) ? settings.cities : []
    const parsedFile = parseImportFile(req.file.buffer, req.file.originalname)
    const rawMappings = parseImportJson<Record<string, string>>(req.body?.mappings, {})
    const rawImportSettings = parseImportJson<{
      fallbackRepresentativeId?: string
      duplicateHandling?: 'skip' | 'overwrite'
    }>(req.body?.settings, {})

    const allowedTargets = new Set<string>([
      ...activeFields.map((field) => field.key),
      ...IMPORT_EXTRA_FIELDS,
      'skip',
    ])

    const mappings = Object.entries(rawMappings).reduce<Record<string, ImportTargetField>>((accumulator, [header, target]) => {
      if (!parsedFile.headers.includes(header)) return accumulator
      accumulator[header] = allowedTargets.has(target) ? (target as ImportTargetField) : 'skip'
      return accumulator
    }, {})

    const requiredFieldKeys = activeFields.filter((field) => field.required).map((field) => field.key)
    const mappedTargets = new Set(Object.values(mappings))
    const missingRequiredMappings = requiredFieldKeys.filter((key) => !mappedTargets.has(key))
    const isRepresentativeImporter = req.user!.role === 'representative'

    if (missingRequiredMappings.length) {
      const missingLabels = activeFields
        .filter((field) => missingRequiredMappings.includes(field.key))
        .map((field) => field.label)

      return res.status(400).json({
        success: false,
        message: `Missing required field mappings: ${missingLabels.join(', ')}`,
      })
    }

    const duplicateHandling = rawImportSettings.duplicateHandling === 'overwrite' ? 'overwrite' : 'skip'

    const importerRepresentative = isRepresentativeImporter
      ? {
          _id: new mongoose.Types.ObjectId(req.user!.id),
          name: req.user!.name,
          email: req.user!.email || null,
          phone: req.user!.phone || null,
        }
      : null

    let fallbackRepresentative: RepresentativeLookupValue | null = null
    if (!isRepresentativeImporter && rawImportSettings.fallbackRepresentativeId) {
      fallbackRepresentative = await User.findOne({
        _id: rawImportSettings.fallbackRepresentativeId,
        role: 'representative',
        isActive: true,
      }).select('name email phone') as RepresentativeLookupValue | null

      if (!fallbackRepresentative) {
        return res.status(404).json({ success: false, message: 'Fallback representative not found' })
      }
    }

    const representatives = await User.find({
      role: 'representative',
      isActive: true,
    }).select('name email phone') as RepresentativeLookupValue[]
    const representativeIndexes = buildRepresentativeLookupIndexes(representatives)

    const mappedLeadFields = new Set<LeadFieldKey>(
      Object.values(mappings).filter((value): value is LeadFieldKey =>
        activeFields.some((field) => field.key === value)
      )
    )
    const fieldConfigByKey = new Map<LeadFieldKey, LeadFieldDefinition>(
      activeFields.map((field) => [field.key, field])
    )
    const hasSourceColumn = Object.values(mappings).includes('source')
    const hasDispositionColumn = Object.values(mappings).includes('disposition')
    const hasOwnerColumn = Object.values(mappings).includes('ownerName')
    const hasFollowUpColumn = Object.values(mappings).includes('nextFollowUp')
    const hasReceivedDateColumn = Object.values(mappings).includes('receivedDate')
    const hasAlternatePhoneColumn = Object.values(mappings).includes('alternatePhone')
    const ownerHeaders = Object.entries(mappings)
      .filter(([, target]) => target === 'ownerName')
      .map(([header]) => header)
    const seenPhones = new Map<string, number>()

    if (!isRepresentativeImporter && hasOwnerColumn && !fallbackRepresentative) {
      const unresolvedRepresentatives = [
        ...new Set(
          parsedFile.rows
            .map((row) => {
              const lastOwnerHeader = ownerHeaders[ownerHeaders.length - 1]
              return lastOwnerHeader ? String(row[lastOwnerHeader] || '').trim() : ''
            })
            .filter((value) => {
              if (!hasMeaningfulValue(value)) return false
              return !resolveRepresentativeAssignment(value, representativeIndexes).representative
            })
        ),
      ]

      if (unresolvedRepresentatives.length) {
        return res.status(400).json({
          success: false,
          message: `Representative "${unresolvedRepresentatives[0]}" was not found. Choose another one from the dropdown and try again.`,
          data: {
            unresolvedRepresentatives,
          },
        })
      }
    }

    let createdCount = 0
    let updatedCount = 0
    let skippedCount = 0
    const errors: Array<{ row: number; message: string }> = []
    const warnings: Array<{ row: number; message: string }> = []

    for (const [index, row] of parsedFile.rows.entries()) {
      const rowNumber = index + 2
      const mappedValues = Object.entries(mappings).reduce<Partial<Record<ImportTargetField, string>>>(
        (accumulator, [header, target]) => {
          if (target === 'skip') return accumulator
          const value = row[header]
          if (!hasMeaningfulValue(value)) return accumulator

          if (target === 'notes') {
            const formattedValue = formatImportedNoteValue(
              header,
              String(value),
              Boolean(accumulator.notes)
            )
            accumulator.notes = accumulator.notes
              ? `${accumulator.notes}\n${formattedValue}`
              : formattedValue
          } else {
            accumulator[target] = String(value).trim()
          }

          return accumulator
        },
        {}
      )

      const leadValues: Partial<Record<LeadFieldKey, unknown>> = {}
      let rowError: string | null = null

      for (const fieldKey of mappedLeadFields) {
        const fieldConfig = fieldConfigByKey.get(fieldKey)
        if (!fieldConfig) continue
        if (fieldKey === 'plotSize') continue

        const coercedValue = coerceImportedLeadFieldValue(fieldConfig, mappedValues[fieldKey], cities)
        if (coercedValue.error) {
          rowError = coercedValue.error
          break
        }
        if (coercedValue.value !== undefined) {
          leadValues[fieldKey] = coercedValue.value
        }
      }

      if (!rowError && hasMeaningfulValue(mappedValues.plotSize)) {
        const plotSizeField = fieldConfigByKey.get('plotSize')
        const parsedPlotSize = parsePlotSizeDetails(
          String(mappedValues.plotSize),
          normalizedLeadFields.plotSizeUnits,
          normalizedLeadFields.defaultUnit
        )

        if (parsedPlotSize.size === null) {
          rowError = `${plotSizeField?.label || 'Plot Size'} must contain a valid number`
        } else {
          leadValues.plotSize = parsedPlotSize.size
          if (!leadValues.plotSizeUnit && parsedPlotSize.unit) {
            leadValues.plotSizeUnit = parsedPlotSize.unit
          }
        }
      }

      if (rowError) {
        skippedCount += 1
        errors.push({ row: rowNumber, message: rowError })
        continue
      }

      const missingRequiredFields = requiredFieldKeys.filter((fieldKey) => {
        const value = leadValues[fieldKey]
        return value === undefined || value === null || String(value).trim() === ''
      })

      if (missingRequiredFields.length) {
        skippedCount += 1
        errors.push({
          row: rowNumber,
          message: `Missing required values: ${missingRequiredFields
            .map((fieldKey) => fieldConfigByKey.get(fieldKey)?.label || fieldKey)
            .join(', ')}`,
        })
        continue
      }

      const normalizedPhone = normalizePhone(String(leadValues.phone || ''))
      if (!normalizedPhone) {
        skippedCount += 1
        errors.push({ row: rowNumber, message: 'Phone Number is invalid' })
        continue
      }

      if (seenPhones.has(normalizedPhone) && duplicateHandling === 'skip') {
        skippedCount += 1
        errors.push({
          row: rowNumber,
          message: `Duplicate phone number also found in row ${seenPhones.get(normalizedPhone)}`,
        })
        continue
      }
      seenPhones.set(normalizedPhone, rowNumber)

      const noteValue = hasMeaningfulValue(mappedValues.notes) ? String(mappedValues.notes).trim() : ''
      const dispositionValue = resolveDisposition(mappedValues.disposition)
      const sourceValue = resolveSource(mappedValues.source)
      const meetingTypeValue = hasMeaningfulValue(mappedValues.meetingType)
        ? (MEETING_TYPES.find((t) => normalizeComparator(t) === normalizeComparator(String(mappedValues.meetingType))) || null)
        : null
      const meetingLocationValue = hasMeaningfulValue(mappedValues.meetingLocation) ? String(mappedValues.meetingLocation).trim() : null
      const failedReasonValue = hasMeaningfulValue(mappedValues.failedReason) ? String(mappedValues.failedReason).trim() : null
      const hasMeetingTypeColumn = Object.values(mappings).includes('meetingType')
      const hasMeetingLocationColumn = Object.values(mappings).includes('meetingLocation')
      const hasFailedReasonColumn = Object.values(mappings).includes('failedReason')
      const followUpDate = hasMeaningfulValue(mappedValues.nextFollowUp)
        ? parseImportedDate(mappedValues.nextFollowUp, { defaultHours: 10, defaultMinutes: 0 })
        : null
      const receivedDate = hasMeaningfulValue(mappedValues.receivedDate)
        ? parseImportedDate(mappedValues.receivedDate, { defaultHours: 0, defaultMinutes: 0 })
        : null

      if (hasFollowUpColumn && hasMeaningfulValue(mappedValues.nextFollowUp) && !followUpDate) {
        skippedCount += 1
        errors.push({ row: rowNumber, message: 'Follow Up date is invalid' })
        continue
      }

      if (hasReceivedDateColumn && hasMeaningfulValue(mappedValues.receivedDate) && !receivedDate) {
        skippedCount += 1
        errors.push({ row: rowNumber, message: 'Lead Received Date is invalid' })
        continue
      }

      const resolvedRepresentative = !isRepresentativeImporter && hasOwnerColumn
        ? resolveRepresentativeAssignment(mappedValues.ownerName, representativeIndexes)
        : { representative: null, warning: null as string | null }
      if (resolvedRepresentative.warning && fallbackRepresentative) {
        warnings.push({
          row: rowNumber,
          message: `Representative "${String(mappedValues.ownerName || '').trim()}" was not found. Assigned to ${fallbackRepresentative.name} instead.`,
        })
      } else if (resolvedRepresentative.warning) {
        warnings.push({ row: rowNumber, message: resolvedRepresentative.warning })
      }

      const ownerFromRow = !isRepresentativeImporter && hasOwnerColumn ? resolvedRepresentative.representative : null
      const finalOwner = isRepresentativeImporter
        ? importerRepresentative
        : hasOwnerColumn
        ? ownerFromRow || fallbackRepresentative
        : null

      const existingLead = await Lead.findOne({
        $or: [
          { phone: { $regex: `${normalizedPhone}$` } },
          { phone: normalizedPhone },
          { alternatePhone: { $regex: `${normalizedPhone}$` } },
          { alternatePhone: normalizedPhone },
        ],
      }).sort({ updatedAt: -1 })

      if (existingLead && duplicateHandling === 'skip') {
        skippedCount += 1
        errors.push({ row: rowNumber, message: 'Lead with this phone number already exists' })
        continue
      }

      if (existingLead && duplicateHandling === 'overwrite') {
        const updatePayload: Record<string, unknown> = {}

        for (const [fieldKey, value] of Object.entries(leadValues)) {
          updatePayload[fieldKey] = fieldKey === 'phone' ? normalizedPhone : value
        }

        if (hasSourceColumn && hasMeaningfulValue(mappedValues.source)) {
          updatePayload.source = sourceValue
        }

        if (hasDispositionColumn && hasMeaningfulValue(mappedValues.disposition)) {
          updatePayload.disposition = dispositionValue
        }

        if (isRepresentativeImporter) {
          updatePayload.owner = importerRepresentative?._id || null
          updatePayload.ownerName = importerRepresentative?.name || null
        } else if (hasOwnerColumn) {
          updatePayload.owner = finalOwner?._id || null
          updatePayload.ownerName = finalOwner?.name || null
        }

        if (hasFollowUpColumn && followUpDate) {
          updatePayload.nextFollowUp = followUpDate
        }

        if (hasReceivedDateColumn && receivedDate) {
          updatePayload.createdAt = receivedDate
        }

        if (hasMeetingTypeColumn && meetingTypeValue) {
          updatePayload.meetingType = meetingTypeValue
        }

        if (hasMeetingLocationColumn && meetingLocationValue) {
          updatePayload.meetingLocation = meetingLocationValue
        }

        if (hasFailedReasonColumn && failedReasonValue) {
          updatePayload.failedReason = failedReasonValue
        }

        if (hasAlternatePhoneColumn && hasMeaningfulValue(mappedValues.alternatePhone)) {
          const normalizedAltPhone = normalizePhone(String(mappedValues.alternatePhone))
          if (normalizedAltPhone) {
            updatePayload.alternatePhone = normalizedAltPhone
          }
        }

        if (noteValue) {
          updatePayload.notes = noteValue
          updatePayload.lastActivityNote = noteValue
          updatePayload.lastActivity = new Date()
          updatePayload.statusNotes = [
            ...(existingLead.statusNotes || []),
            buildImportedStatusNote(
              hasDispositionColumn && hasMeaningfulValue(mappedValues.disposition)
                ? dispositionValue
                : existingLead.disposition,
              noteValue,
              req
            ),
          ]
        }

        const updatedLead = await Lead.findByIdAndUpdate(existingLead._id, updatePayload, {
          new: true,
          runValidators: true,
        })

        if (updatedLead && (hasFollowUpColumn || hasOwnerColumn || isRepresentativeImporter)) {
          await syncImportedFollowUpReminder({
            leadId: updatedLead._id,
            leadName: updatedLead.name,
            ownerId: isRepresentativeImporter
              ? importerRepresentative?._id || null
              : hasOwnerColumn
              ? finalOwner?._id || null
              : updatedLead.owner || null,
            ownerName: isRepresentativeImporter
              ? importerRepresentative?.name || null
              : hasOwnerColumn
              ? finalOwner?.name || null
              : updatedLead.ownerName || null,
            dueAt: hasFollowUpColumn ? followUpDate : updatedLead.nextFollowUp || null,
            notes: noteValue || updatedLead.notes || null,
          })
        }

        updatedCount += 1
        continue
      }

      const importedAltPhone = hasAlternatePhoneColumn && hasMeaningfulValue(mappedValues.alternatePhone)
        ? normalizePhone(String(mappedValues.alternatePhone)) || null
        : null

      const createdLead = await Lead.create({
        name: String(leadValues.name || '').trim(),
        phone: normalizedPhone,
        alternatePhone: importedAltPhone,
        email: typeof leadValues.email === 'string' ? leadValues.email : null,
        city: typeof leadValues.city === 'string' ? leadValues.city : 'Unknown',
        source: sourceValue,
        disposition: dispositionValue,
        meetingType: meetingTypeValue || null,
        meetingLocation: meetingLocationValue || null,
        failedReason: failedReasonValue || null,
        owner: finalOwner?._id || null,
        ownerName: finalOwner?.name || null,
        budget: typeof leadValues.budget === 'string' ? leadValues.budget : null,
        plotSize: typeof leadValues.plotSize === 'number' ? leadValues.plotSize : null,
        plotSizeUnit: typeof leadValues.plotSizeUnit === 'string' ? leadValues.plotSizeUnit : null,
        plotOwned: typeof leadValues.plotOwned === 'boolean' ? leadValues.plotOwned : null,
        buildType: typeof leadValues.buildType === 'string' ? leadValues.buildType : null,
        campaign: typeof leadValues.campaign === 'string' ? leadValues.campaign : null,
        isInQueue: false,
        nextFollowUp: followUpDate || null,
        lastActivity: receivedDate || new Date(),
        lastActivityNote: noteValue || 'Imported via bulk import',
        notes: noteValue || null,
        statusNotes: noteValue ? [buildImportedStatusNote(dispositionValue, noteValue, req)] : [],
        createdAt: receivedDate || undefined,
        updatedAt: receivedDate || undefined,
      })

      await syncImportedFollowUpReminder({
        leadId: createdLead._id,
        leadName: createdLead.name,
        ownerId: createdLead.owner || null,
        ownerName: createdLead.ownerName || null,
        dueAt: followUpDate,
        notes: noteValue || createdLead.notes || null,
      })

      createdCount += 1
    }

    if (createdCount + updatedCount > 0) {
      emitToTeam('all', 'lead:incoming', {
        imported: {
          createdCount,
          updatedCount,
        },
      })
    }

    return res.status(200).json({
      success: true,
      data: {
        totalRows: parsedFile.rows.length,
        createdCount,
        updatedCount,
        skippedCount,
        errorCount: errors.length,
        errors: errors.slice(0, 100),
        warningCount: warnings.length,
        warnings: warnings.slice(0, 100),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const getLeadFilters = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [dbCities, dbSources, settings, owners] = await Promise.all([
      Lead.distinct('city'),
      Lead.distinct('source'),
      Settings.findOne({}, 'cities sources'),
      User.find({ role: 'representative', isActive: true }, 'name _id').sort({ name: 1 }),
    ])

    // If settings has configured cities, use those. Otherwise fallback to distinct cities from DB.
    const citiesToReturn = (settings?.cities && settings.cities.length > 0)
      ? settings.cities
      : dbCities.filter(c => c && c !== 'Unknown')

    // Sources — Settings is the single source of truth.
    // If a manager curated the sources list, respect it strictly. Don't auto-resurrect
    // values that only exist on legacy/orphaned leads (e.g. mistaken entries like a
    // location name). Fallback to the LEAD_SOURCES constant only when no settings
    // entry exists at all.
    const allSources = (settings?.sources && settings.sources.length > 0)
      ? [...settings.sources].sort()
      : Array.from(
          new Set([...LEAD_SOURCES, ...dbSources.filter((s): s is string => Boolean(s))])
        ).sort()

    return res.status(200).json({
      success: true,
      data: {
        cities: citiesToReturn.sort(),
        sources: allSources,
        dispositions: DISPOSITIONS,
        owners: owners.map(o => ({ id: String(o._id), name: o.name })),
        leadFields: normalizeLeadFields(settings?.leadFields),
      },
    })
  } catch (err) {
    next(err)
  }
}

export const lookupLeadsByPhones = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const phones: unknown[] = Array.isArray(req.body?.phones) ? req.body.phones : []
    const normalizedPhones: string[] = [
      ...new Set(
        phones
          .map((phone: unknown) => normalizePhone(String(phone)))
          .filter((phone): phone is string => Boolean(phone))
      ),
    ]

    if (normalizedPhones.length === 0) {
      return res.status(200).json({ success: true, data: {} })
    }

    const leads = await Lead.find({
      $or: normalizedPhones.flatMap((phone) => [
        { phone: { $regex: `${phone}$` } },
        { alternatePhone: { $regex: `${phone}$` } },
      ]),
    }).sort({ updatedAt: -1 })

    const data = normalizedPhones.reduce<Record<string, any>>((acc, phone: string) => {
      const matchingLead = leads.find((lead) =>
        (normalizePhone(lead.phone) === phone || normalizePhone(lead.alternatePhone || '') === phone) &&
        canAccessLead(req, lead)
      )

      acc[phone] = matchingLead
        ? {
            exists: true,
            lead: {
              _id: String(matchingLead._id),
              name: matchingLead.name,
              phone: matchingLead.phone,
              alternatePhone: matchingLead.alternatePhone || null,
              city: matchingLead.city,
              source: matchingLead.source,
              disposition: matchingLead.disposition,
            },
          }
        : { exists: false, lead: null }

      return acc
    }, {})

    return res.status(200).json({ success: true, data })

  } catch (err) {
    next(err)
  }
}

export const getLeads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = '1',
      limit = '20',

      search,
      disposition,
      source,
      city,
      owner,
      reminderStatus,
      dateFrom,
      dateTo,
      followUp,
    } = req.query as Record<string, string>

    const filter: Record<string, unknown> = {}
    const normalizedSearch = String(search || '').trim()
    const normalizedDisposition = String(disposition || '').trim()
    const normalizedSource = String(source || '').trim()
    const normalizedCity = String(city || '').trim()
    const normalizedOwner = String(owner || '').trim()
    const normalizedReminderStatus = String(reminderStatus || '').trim()
    const normalizedDateFrom = String(dateFrom || '').trim()
    const normalizedDateTo = String(dateTo || '').trim()

    if (normalizedSearch) {
      filter.$or = [
        { name: { $regex: normalizedSearch, $options: 'i' } },
        { phone: { $regex: normalizedSearch, $options: 'i' } },
        { alternatePhone: { $regex: normalizedSearch, $options: 'i' } },
        { email: { $regex: normalizedSearch, $options: 'i' } },
      ]
    }
    if (normalizedDisposition && normalizeComparator(normalizedDisposition) !== 'all') {
      filter.disposition = resolveDisposition(normalizedDisposition)
    }
    if (normalizedSource && normalizeComparator(normalizedSource) !== 'all') {
      filter.source = resolveSource(normalizedSource)
    }
    if (normalizedCity && normalizeComparator(normalizedCity) !== 'all') {
      filter.city = normalizedCity
    }
    if (normalizeComparator(normalizedOwner) === 'unassigned') {
      filter.owner = null
    } else if (normalizedOwner && normalizeComparator(normalizedOwner) !== 'all' && mongoose.Types.ObjectId.isValid(normalizedOwner)) {
      filter.owner = new mongoose.Types.ObjectId(normalizedOwner)
    }
    if (normalizedReminderStatus && normalizeComparator(normalizedReminderStatus) !== 'all') {
      filter.reminderStatus = normalizedReminderStatus
    }

    // Follow-up filter. Terminal dispositions are excluded from "without" /
    // "overdue" because closed leads never need ongoing follow-ups.
    const normalizedFollowUp = String(followUp || '').trim().toLowerCase()
    const TERMINAL_DISPOSITIONS = ['Failed', 'Booking Done', 'Agreement Done']
    if (normalizedFollowUp === 'with') {
      filter.nextFollowUp = { $ne: null, $exists: true }
    } else if (normalizedFollowUp === 'without') {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? (filter.$and as any[]) : []),
        {
          $or: [
            { nextFollowUp: null },
            { nextFollowUp: { $exists: false } },
          ],
        },
        { disposition: { $nin: TERMINAL_DISPOSITIONS } },
      ]
    } else if (normalizedFollowUp === 'overdue') {
      filter.nextFollowUp = { $ne: null, $lt: new Date() }
      filter.$and = [
        ...(Array.isArray(filter.$and) ? (filter.$and as any[]) : []),
        { disposition: { $nin: TERMINAL_DISPOSITIONS } },
      ]
    }

    const parsedDateFrom = normalizedDateFrom ? new Date(normalizedDateFrom) : null
    const parsedDateTo = normalizedDateTo ? new Date(normalizedDateTo) : null

    if (
      (parsedDateFrom && !Number.isNaN(parsedDateFrom.getTime())) ||
      (parsedDateTo && !Number.isNaN(parsedDateTo.getTime()))
    ) {
      filter.createdAt = {
        ...(parsedDateFrom && !Number.isNaN(parsedDateFrom.getTime()) && { $gte: parsedDateFrom }),
        ...(parsedDateTo && !Number.isNaN(parsedDateTo.getTime()) && { $lte: parsedDateTo }),
      }
    }

    // Representatives now see ALL leads (read-only for leads they don't own).
    // Write operations (update, assign, delete) still require canAccessLead.
    // If the rep passed owner=myId it still filters correctly; we just don't force it.

    const pageNum = Math.max(1, parseInt(page))
    const limitNum = Math.min(100, parseInt(limit))
    const skip = (pageNum - 1) * limitNum

    const [leads, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Lead.countDocuments(filter),
    ])

    return res.status(200).json({
      success: true,
      data: leads,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    next(err)
  }
}

export const getLeadById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lead = await Lead.findById(req.params.id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    // Any authenticated user can VIEW any lead.
    // Edit/delete/assign operations enforce ownership via canAccessLead.
    return res.status(200).json({ success: true, data: lead })
  } catch (err) {
    next(err)
  }
}

export const createLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const initialNote = typeof req.body.notes === 'string' ? req.body.notes.trim() : ''
    const initialDisposition = req.body.disposition && DISPOSITIONS.includes(req.body.disposition) ? req.body.disposition : 'New'
    const resolvedSource = resolveSource(req.body.source)
    const normalizedPhone = normalizePhone(req.body.phone)
    let createdAt: Date | undefined

    if (req.body?.createdAt !== undefined) {
      try {
        createdAt = parseRequestedCreatedAt(req.body.createdAt)
      } catch (error: any) {
        return res.status(400).json({
          success: false,
          message: error instanceof Error ? error.message : 'Created at date and time is invalid',
        })
      }
    }

    if (normalizedPhone) {
      const existingLead = await Lead.findOne({
        $or: [
          { phone: { $regex: `${normalizedPhone}$` } },
          { alternatePhone: { $regex: `${normalizedPhone}$` } },
        ],
      }).sort({ updatedAt: -1 })

      if (existingLead) {
        return res.status(409).json({
          success: false,
          message: existingLead.phone === normalizedPhone || existingLead.phone.endsWith(normalizedPhone)
            ? 'Lead already exists for this phone number'
            : 'Lead already exists — this number is the alternate phone of an existing lead',
          data: {
            _id: String(existingLead._id),
            name: existingLead.name,
            phone: existingLead.phone,
            alternatePhone: existingLead.alternatePhone || null,
            city: existingLead.city,
            source: existingLead.source,
            disposition: existingLead.disposition,
          },
        })
      }
    }

    const isRepresentativeCreator = req.user!.role === 'representative'
    const payload = {
      ...req.body,
      source: resolvedSource,
      owner: isRepresentativeCreator ? req.user!.id : null,
      ownerName: isRepresentativeCreator ? req.user!.name : null,
      disposition: initialDisposition,
      isInQueue: false,
      lastActivity: new Date(),
      lastActivityNote: initialNote || req.body.lastActivityNote || 'Created manually in BuildFlow',
      notes: initialNote || req.body.notes || null,
      statusNotes: initialNote ? [buildStatusNote(initialDisposition, initialNote, req)] : [],
      createdAt,
    }

    const lead = await Lead.create({
      ...payload,
      createdBy: req.user!.id,
    })

    await QueueItem.deleteMany({ leadId: lead._id })

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.created',
      entity: 'Lead',
      entityId: String(lead._id),
      after: lead.toObject(),
    })

    // Notify team about new lead
    emitToTeam('all', 'lead:incoming', {
      lead: { 
        id: lead._id, 
        _id: lead._id,
        name: lead.name, 
        phone: lead.phone, 
        city: lead.city, 
        source: lead.source,
        owner: lead.owner || null
      }
    })

    void notifyNewLeadCreated(lead).catch(() => null)
    // If a manager created this lead unassigned and round-robin mode is on,
    // auto-route it now. Reps always self-own so this is a no-op for them.
    if (!isRepresentativeCreator) {
      void routeLead(lead._id).catch(() => null)
    }

    return res.status(201).json({ success: true, data: lead })
  } catch (err) {
    next(err)
  }
}

export const updateLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await Lead.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this lead' })
    }

    const before = existing.toObject()
    const updates = { ...req.body }

    if (req.body?.createdAt !== undefined) {
      try {
        updates.createdAt = parseRequestedCreatedAt(req.body.createdAt)
      } catch (error: any) {
        return res.status(400).json({
          success: false,
          message: error instanceof Error ? error.message : 'Created at date and time is invalid',
        })
      }
    }

    const { $set, $push, ...directUpdates } = updates as any
    const rawUpdate: Record<string, unknown> = {
      $set: {
        ...directUpdates,
        ...$set,
        updatedAt: new Date(),
      },
    }
    if ($push) rawUpdate.$push = $push
    await Lead.collection.updateOne({ _id: existing._id }, rawUpdate)

    const lead = await Lead.findById(req.params.id)

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.updated',
      entity: 'Lead',
      entityId: req.params.id,
      before,
      after: lead!.toObject(),
    })

    return res.status(200).json({ success: true, data: lead })
  } catch (err) {
    next(err)
  }
}

export const deleteLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Only managers can delete leads' })
    }

    const lead = await Lead.findById(req.params.id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    if (!canAccessLead(req, lead)) {
      return res.status(403).json({ success: false, message: 'Not allowed to delete this lead' })
    }

    await Lead.deleteOne({ _id: lead._id })
    await deleteLeadDependencies([lead._id])

    // Block phone from being auto-recreated by Exotel webhooks / call sync
    await blockDeletedPhones([lead.phone, lead.alternatePhone].filter(Boolean) as string[])

    // Block Meta/Make externalId from being re-imported via the Make webhook
    await blockDeletedExternalIds([
      { externalId: lead.externalId, source: lead.source },
      { externalId: lead.metaLeadId, source: lead.source || 'Meta' },
    ])

    // Audit log is fire-and-forget — its failure must not roll back an already-deleted lead
    AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.deleted',
      entity: 'Lead',
      entityId: req.params.id,
      before: lead.toObject(),
    }).catch((auditErr) => {
      console.error('AuditLog creation failed for lead deletion:', auditErr)
    })

    emitToTeam('all', 'lead:deleted', {
      leadIds: [String(lead._id)],
      deletedCount: 1,
    })

    return res.status(200).json({ success: true, message: 'Lead deleted' })
  } catch (err) {
    next(err)
  }
}

export const bulkDeleteLeads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Only managers can delete leads' })
    }

    const requestedIds: string[] = Array.isArray(req.body?.ids)
      ? Array.from(new Set<string>(req.body.ids.map((id: unknown) => String(id)).filter(Boolean)))
      : []

    if (!requestedIds.length) {
      return res.status(400).json({ success: false, message: 'Select at least one lead to delete' })
    }

    const leads = await Lead.find({ _id: { $in: requestedIds } })
    const accessibleLeads = leads.filter((lead) => canAccessLead(req, lead))
    const accessibleIds = accessibleLeads.map((lead) => lead._id)
    const deletedIdStrings = accessibleLeads.map((lead) => String(lead._id))
    const skippedIds = requestedIds.filter((id) => !deletedIdStrings.includes(id))

    if (!accessibleLeads.length) {
      return res.status(403).json({ success: false, message: 'Not allowed to delete the selected leads' })
    }

    await Lead.deleteMany({ _id: { $in: accessibleIds } })
    await deleteLeadDependencies(accessibleIds)

    // Block phones from being auto-recreated by Exotel webhooks / call sync
    const phonesToBlock = accessibleLeads.flatMap((lead) =>
      [lead.phone, lead.alternatePhone].filter(Boolean) as string[]
    )
    await blockDeletedPhones(phonesToBlock)

    // Block externalIds from being re-imported via the Make webhook
    const externalIdsToBlock = accessibleLeads.flatMap((lead) => [
      { externalId: lead.externalId, source: lead.source },
      { externalId: lead.metaLeadId, source: lead.source || 'Meta' },
    ])
    await blockDeletedExternalIds(externalIdsToBlock)

    // Audit log is fire-and-forget — its failure must not affect the success response
    AuditLog.insertMany(
      accessibleLeads.map((lead) => ({
        actor: req.user!.id,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        action: 'lead.deleted',
        entity: 'Lead',
        entityId: String(lead._id),
        before: lead.toObject(),
      }))
    ).catch((auditErr) => {
      console.error('AuditLog insertion failed for bulk lead deletion:', auditErr)
    })

    emitToTeam('all', 'lead:deleted', {
      leadIds: deletedIdStrings,
      deletedCount: deletedIdStrings.length,
    })

    return res.status(200).json({
      success: true,
      message:
        deletedIdStrings.length === 1
          ? '1 lead deleted successfully'
          : `${deletedIdStrings.length} leads deleted successfully`,
      data: {
        deletedIds: deletedIdStrings,
        deletedCount: deletedIdStrings.length,
        skippedIds,
        skippedCount: skippedIds.length,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const assignLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = req.body.userId || req.body.assignedTo || null
    const before = await Lead.findById(req.params.id)
    if (!before) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, before)) {
      return res.status(403).json({ success: false, message: 'You do not have access to reassign this lead' })
    }
    if (req.user!.role === 'representative' && !targetUserId) {
      return res.status(403).json({ success: false, message: 'Representatives can only transfer leads to another representative' })
    }

    let owner = null
    let ownerName = null
    let representativeEmail: string | null = null
    let representativeNotificationPrefs: any = null

    if (targetUserId) {
      const representative = await User.findOne({ _id: targetUserId, role: 'representative', isActive: true }).select(
        'name email notificationPrefs'
      )
      if (!representative) {
        return res.status(404).json({ success: false, message: 'Representative not found' })
      }
      owner = representative._id
      ownerName = representative.name
      representativeEmail = representative.email
      representativeNotificationPrefs = representative.notificationPrefs
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      {
        owner,
        ownerName,
        assignedAt: owner ? new Date() : null,
        isInQueue: false,
        // Require acknowledgement only when assigning to someone; clear it on unassign
        assignmentAcknowledged: owner ? false : true,
      },
      { new: true }
    )

    await QueueItem.deleteMany({ leadId: before._id })

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: owner ? 'lead.assigned' : 'lead.unassigned',
      entity: 'Lead',
      entityId: req.params.id,
      before: before.toObject(),
      after: lead!.toObject(),
    })

    emitToTeam('all', 'lead:assigned', {
      leadId: String(lead!._id),
      leadName: lead!.name,
      assignedTo: owner ? String(owner) : null,
      assignedToName: ownerName,
    })

    if (
      owner &&
      representativeEmail &&
      normalizeNotificationPrefs(representativeNotificationPrefs).assignmentAlerts
    ) {
      void sendLeadAssignedEmail(
        representativeEmail,
        ownerName || 'Representative',
        lead!.name,
        lead!.phone,
        lead!.city || 'Unknown',
        lead!.source,
        String(lead!._id)
      ).catch(() => null)
    }

    return res.status(200).json({ success: true, data: lead })
  } catch (err) {
    next(err)
  }
}

export const getPendingAssignments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leads = await Lead.find({
      owner: req.user!.id,
      assignmentAcknowledged: false,
    })
      .select('_id name phone city source disposition assignedAt')
      .sort({ assignedAt: -1 })
      .lean()

    return res.status(200).json({
      success: true,
      data: leads.map((lead) => ({
        leadId: String(lead._id),
        leadName: lead.name,
        phone: lead.phone,
        city: lead.city,
        source: lead.source,
        disposition: lead.disposition,
        assignedAt: lead.assignedAt,
      })),
    })
  } catch (err) {
    next(err)
  }
}

export const respondToAssignment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { action } = req.body // 'accept' | 'decline'
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'accept' or 'decline'" })
    }

    const lead = await Lead.findById(req.params.id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    // Only the assigned rep (or a manager) can respond
    if (req.user!.role === 'representative' && String(lead.owner) !== req.user!.id) {
      return res.status(403).json({ success: false, message: 'You are not assigned to this lead' })
    }

    if (action === 'accept') {
      await Lead.findByIdAndUpdate(lead._id, { $set: { assignmentAcknowledged: true } })
      return res.status(200).json({ success: true, data: { leadId: String(lead._id), action: 'accepted' } })
    }

    // Decline — remove assignment
    const before = lead.toObject()
    await Lead.findByIdAndUpdate(lead._id, {
      $set: {
        owner: null,
        ownerName: null,
        assignedAt: null,
        assignmentAcknowledged: true,
      },
    })

    AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.assignment_declined',
      entity: 'Lead',
      entityId: String(lead._id),
      before,
      after: { ...before, owner: null, ownerName: null, assignedAt: null, assignmentAcknowledged: true },
    }).catch(() => null)

    emitToTeam('all', 'lead:assigned', {
      leadId: String(lead._id),
      leadName: lead.name,
      assignedTo: null,
      assignedToName: null,
    })

    return res.status(200).json({ success: true, data: { leadId: String(lead._id), action: 'declined' } })
  } catch (err) {
    next(err)
  }
}

export const updateDisposition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { disposition, notes } = req.body
    const existing = await Lead.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this lead' })
    }

    const before = existing.toObject()
    const nextNote = typeof notes === 'string' ? notes.trim() : ''
    if (!nextNote) {
      return res.status(400).json({
        success: false,
        message: 'A note is required whenever you change the lead status',
      })
    }
    existing.disposition = disposition
    existing.lastActivityNote = nextNote
    existing.notes = nextNote
    existing.statusNotes = [...(existing.statusNotes || []), buildStatusNote(disposition, nextNote, req)]
    existing.lastActivity = new Date()
    await existing.save()

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.disposition_changed',
      entity: 'Lead',
      entityId: req.params.id,
      before,
      after: existing.toObject(),
    })

    return res.status(200).json({ success: true, data: existing })
  } catch (err) {
    next(err)
  }
}

export const addStatusNote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, note } = req.body
    const trimmedNote = typeof note === 'string' ? note.trim() : ''

    if (!status || !DISPOSITIONS.includes(status)) {
      return res.status(400).json({ success: false, message: `Valid status is required. Allowed: ${DISPOSITIONS.join(', ')}` })
    }

    if (!trimmedNote) {
      return res.status(400).json({ success: false, message: 'Note is required' })
    }

    const existing = await Lead.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this lead' })
    }

    const before = existing.toObject()
    existing.statusNotes = [...(existing.statusNotes || []), buildStatusNote(status, trimmedNote, req)]
    syncLatestLeadNote(existing)
    await existing.save()

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.status_note_added',
      entity: 'Lead',
      entityId: req.params.id,
      before,
      after: existing.toObject(),
    })

    return res.status(200).json({ success: true, data: existing })
  } catch (err) {
    next(err)
  }
}

export const updateStatusNote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, note } = req.body
    const trimmedNote = typeof note === 'string' ? note.trim() : ''

    if (!status || !DISPOSITIONS.includes(status)) {
      return res.status(400).json({ success: false, message: `Valid status is required. Allowed: ${DISPOSITIONS.join(', ')}` })
    }

    if (!trimmedNote) {
      return res.status(400).json({ success: false, message: 'Note is required' })
    }

    const existing = await Lead.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this lead' })
    }

    const noteEntry = (existing.statusNotes as Array<any>).find(
      (item) => String(item?._id) === String(req.params.noteId)
    )
    if (!noteEntry) {
      return res.status(404).json({ success: false, message: 'Status note not found' })
    }

    const before = existing.toObject()
    noteEntry.status = status
    noteEntry.note = trimmedNote
    syncLatestLeadNote(existing)
    await existing.save()

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.status_note_updated',
      entity: 'Lead',
      entityId: req.params.id,
      before,
      after: existing.toObject(),
    })

    return res.status(200).json({ success: true, data: existing })
  } catch (err) {
    next(err)
  }
}

export const deleteStatusNote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await Lead.findById(req.params.id)
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }
    if (!canAccessLead(req, existing)) {
      return res.status(403).json({ success: false, message: 'You do not have access to update this lead' })
    }

    const noteEntry = (existing.statusNotes as Array<any>).find(
      (item) => String(item?._id) === String(req.params.noteId)
    )
    if (!noteEntry) {
      return res.status(404).json({ success: false, message: 'Status note not found' })
    }

    const before = existing.toObject()
    existing.statusNotes = (existing.statusNotes as Array<any>).filter(
      (item) => String(item?._id) !== String(req.params.noteId)
    )
    syncLatestLeadNote(existing)
    await existing.save()

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'lead.status_note_deleted',
      entity: 'Lead',
      entityId: req.params.id,
      before,
      after: existing.toObject(),
    })

    return res.status(200).json({ success: true, data: existing })
  } catch (err) {
    next(err)
  }
}

// Lead fields available for export
const EXPORTABLE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'email', label: 'Email' },
  { key: 'city', label: 'City' },
  { key: 'source', label: 'Source' },
  { key: 'disposition', label: 'Disposition' },
  { key: 'ownerName', label: 'Owner' },
  { key: 'budget', label: 'Budget' },
  { key: 'plotSize', label: 'Plot Size' },
  { key: 'plotSizeUnit', label: 'Plot Size Unit' },
  { key: 'plotOwned', label: 'Plot Owned' },
  { key: 'buildType', label: 'Build Type' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'meetingType', label: 'Meeting Type' },
  { key: 'meetingLocation', label: 'Meeting Location' },
  { key: 'failedReason', label: 'Failed Reason' },
  { key: 'notes', label: 'Notes' },
  { key: 'lastActivity', label: 'Last Activity' },
  { key: 'lastActivityNote', label: 'Last Activity Note' },
  { key: 'nextFollowUp', label: 'Next Follow Up' },
  { key: 'createdAt', label: 'Created At' },
  { key: 'updatedAt', label: 'Updated At' },
]

export const exportLeads = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Only managers can export leads' })
    }

    const { dateRange, fields, format = 'csv', owner } = req.body
    
    // Validate date range
    const validDateRanges = ['today', 'week', 'month', 'lifetime']
    if (!dateRange || !validDateRanges.includes(dateRange)) {
      return res.status(400).json({ success: false, message: 'Valid dateRange is required (today, week, month, lifetime)' })
    }

    // Validate fields
    const fieldsToExport = fields && Array.isArray(fields) && fields.length > 0 
      ? fields 
      : EXPORTABLE_FIELDS.map(f => f.key)
    
    // Build date filter
    const now = new Date()
    let dateFrom: Date | null = null
    
    if (dateRange === 'today') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else if (dateRange === 'week') {
      const day = now.getDay()
      const diff = (day + 6) % 7
      dateFrom = new Date(now)
      dateFrom.setDate(now.getDate() - diff)
      dateFrom.setHours(0, 0, 0, 0)
    } else if (dateRange === 'month') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1)
    }
    // lifetime: no date filter

    // Build query
    const query: any = {}

    if (owner === 'unassigned') {
      query.owner = null
    } else if (owner) {
      if (!mongoose.Types.ObjectId.isValid(String(owner))) {
        return res.status(400).json({ success: false, message: 'Invalid representative filter' })
      }
      query.owner = new mongoose.Types.ObjectId(owner)
    }

    // Apply date filter
    if (dateFrom) {
      query.createdAt = { $gte: dateFrom }
    }

    // Fetch all matching leads (no pagination for export)
    const leads = await Lead.find(query)
      .populate('owner', 'name email phone')
      .sort({ createdAt: -1 })
      .lean()

    // Transform leads for export
    const exportData = leads.map((lead: any) => {
      const row: Record<string, any> = {}
      
      fieldsToExport.forEach((field: string) => {
        switch (field) {
          case 'ownerName':
            row[field] = lead.owner?.name || 'Unassigned'
            break
          case 'plotOwned':
            row[field] = lead.plotOwned === true ? 'Yes' : lead.plotOwned === false ? 'No' : ''
            break
          case 'createdAt':
          case 'updatedAt':
          case 'lastActivity':
          case 'nextFollowUp':
            row[field] = lead[field] ? new Date(lead[field]).toISOString() : ''
            break
          default:
            row[field] = lead[field] ?? ''
        }
      })
      
      return row
    })

    // Get field labels
    const fieldLabels = fieldsToExport.map((key: string) => {
      const fieldDef = EXPORTABLE_FIELDS.find(f => f.key === key)
      return fieldDef?.label || key
    })

    // Generate CSV
    if (format === 'csv') {
      const csvHeaders = fieldLabels.join(',')
      const csvRows = exportData.map((row: any) => {
        return fieldsToExport.map((field: string) => {
          const value = row[field]
          // Escape values with commas or quotes
          const stringValue = String(value ?? '')
          if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
            return `"${stringValue.replace(/"/g, '""')}"`
          }
          return stringValue
        }).join(',')
      })
      const csvContent = [csvHeaders, ...csvRows].join('\n')

      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', `attachment; filename="leads_${dateRange}_${new Date().toISOString().split('T')[0]}.csv"`)
      return res.status(200).send(csvContent)
    }

    // JSON format
    return res.status(200).json({
      success: true,
      data: exportData,
      meta: {
        total: exportData.length,
        dateRange,
        fields: fieldLabels,
      },
    })
  } catch (err) {
    next(err)
  }
}

// ==================== FollowUp Controllers ====================

export const getLeadFollowUps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    // Verify lead exists and user has access
    const lead = await Lead.findById(id).lean()
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    // Access control for representatives
    if (req.user!.role === 'representative') {
      const isOwner = lead.owner && String(lead.owner) === String(req.user!.id)
      const isUnassigned = !lead.owner || String(lead.owner) === ''
      if (!isOwner && !isUnassigned) {
        return res.status(403).json({ success: false, message: 'Access denied' })
      }
    }

    const followUps = await FollowUp.find({ lead: new mongoose.Types.ObjectId(id) })
      .sort({ scheduledAt: -1 })
      .lean()

    return res.status(200).json({ success: true, data: followUps })
  } catch (err) {
    next(err)
  }
}

export const createFollowUp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
    const { scheduledAt, notes } = req.body

    if (!scheduledAt) {
      return res.status(400).json({ success: false, message: 'scheduledAt is required' })
    }

    // Verify lead exists and user has access
    const lead = await Lead.findById(id)
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' })
    }

    // Access control for representatives
    if (req.user!.role === 'representative') {
      const isOwner = lead.owner && String(lead.owner) === String(req.user!.id)
      const isUnassigned = !lead.owner || String(lead.owner) === ''
      if (!isOwner && !isUnassigned) {
        return res.status(403).json({ success: false, message: 'Access denied' })
      }
    }

    const followUp = await FollowUp.create({
      lead: new mongoose.Types.ObjectId(id),
      leadName: lead.name || 'Unknown',
      owner: new mongoose.Types.ObjectId(req.user!.id),
      ownerName: req.user!.name || 'Unknown',
      scheduledAt: new Date(scheduledAt),
      notes: notes || null,
      status: 'pending',
      notificationStates: [],
    })

    // Update lead's nextFollowUp field if this is the earliest pending follow-up
    const allFollowUps = await FollowUp.find({
      lead: new mongoose.Types.ObjectId(id),
      status: 'pending',
    }).sort({ scheduledAt: 1 }).limit(1)

    if (allFollowUps.length > 0) {
      lead.nextFollowUp = allFollowUps[0].scheduledAt
      await lead.save()
    }

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'followup.created',
      entity: 'FollowUp',
      entityId: followUp._id.toString(),
      after: followUp.toObject(),
    })

    return res.status(201).json({ success: true, data: followUp })
  } catch (err) {
    next(err)
  }
}

export const updateFollowUp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, followUpId } = req.params
    const { scheduledAt, notes, status } = req.body

    const followUp = await FollowUp.findById(followUpId)
    if (!followUp) {
      return res.status(404).json({ success: false, message: 'Follow-up not found' })
    }

    // Verify the follow-up belongs to this lead
    if (String(followUp.lead) !== id) {
      return res.status(400).json({ success: false, message: 'Follow-up does not belong to this lead' })
    }

    // Fetch the lead early so we can check CURRENT ownership (not the original follow-up creator).
    // After reassignment the new owner must be able to edit follow-ups set by the old owner.
    const lead = await Lead.findById(id)

    // Access control: check against the lead's current owner, not the follow-up creator
    if (req.user!.role === 'representative' && String(lead?.owner) !== String(req.user!.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' })
    }

    const before = followUp.toObject()

    if (scheduledAt !== undefined) {
      followUp.scheduledAt = new Date(scheduledAt)
      followUp.notificationStates = []
    }
    if (notes !== undefined) {
      followUp.notes = notes || null
    }
    if (status !== undefined) {
      followUp.status = status
      followUp.notificationStates = []
      if (status === 'completed' && !followUp.completedAt) {
        followUp.completedAt = new Date()
      } else if (status !== 'completed') {
        followUp.completedAt = null
      }
    }

    await followUp.save()

    // Update lead's nextFollowUp if needed
    if (lead) {
      const pendingFollowUps = await FollowUp.find({
        lead: new mongoose.Types.ObjectId(id),
        status: 'pending',
      }).sort({ scheduledAt: 1 }).limit(1)

      lead.nextFollowUp = pendingFollowUps.length > 0 ? pendingFollowUps[0].scheduledAt : null
      await lead.save()
    }

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'followup.updated',
      entity: 'FollowUp',
      entityId: followUp._id.toString(),
      before,
      after: followUp.toObject(),
    })

    return res.status(200).json({ success: true, data: followUp })
  } catch (err) {
    next(err)
  }
}

export const deleteFollowUp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, followUpId } = req.params

    const followUp = await FollowUp.findById(followUpId)
    if (!followUp) {
      return res.status(404).json({ success: false, message: 'Follow-up not found' })
    }

    // Verify the follow-up belongs to this lead
    if (String(followUp.lead) !== id) {
      return res.status(400).json({ success: false, message: 'Follow-up does not belong to this lead' })
    }

    // Fetch lead early to check CURRENT ownership (not original follow-up creator).
    // After reassignment the new lead owner gets full control over all follow-ups.
    const lead = await Lead.findById(id)

    // Access control: current lead owner, not the follow-up's original creator
    if (req.user!.role === 'representative' && String(lead?.owner) !== String(req.user!.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' })
    }

    const before = followUp.toObject()

    await FollowUp.findByIdAndDelete(followUpId)

    // Update lead's nextFollowUp if needed
    if (lead) {
      const pendingFollowUps = await FollowUp.find({
        lead: new mongoose.Types.ObjectId(id),
        status: 'pending',
      }).sort({ scheduledAt: 1 }).limit(1)

      lead.nextFollowUp = pendingFollowUps.length > 0 ? pendingFollowUps[0].scheduledAt : null
      await lead.save()
    }

    await AuditLog.create({
      actor: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'followup.deleted',
      entity: 'FollowUp',
      entityId: followUp._id.toString(),
      before,
    })

    return res.status(200).json({ success: true, message: 'Follow-up deleted' })
  } catch (err) {
    next(err)
  }
}
