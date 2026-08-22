/**
 * Lead export field definitions and CSV building.
 *
 * Kept out of the controller so the field-resolution rules (which decide the
 * exact columns a CSV ends up with) can be exercised without a database or an
 * HTTP request.
 */

export interface ExportableField {
  key: string
  label: string
  /**
   * Columns computed from statusNotes rather than read off the lead document.
   * They're only meaningful alongside the prior-milestone preset, so they are
   * excluded from the "no fields specified" default column set.
   */
  milestoneOnly?: boolean
}

// Canonical column list. The order here is the order columns appear in the
// CSV — a selection never reorders columns, so two exports with the same
// fields always look the same regardless of the order they were ticked.
export const EXPORTABLE_FIELDS: ExportableField[] = [
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
  // Computed columns derived from statusNotes — useful for re-targeting
  // failed leads that previously reached a visit / meeting milestone.
  { key: 'priorMilestones', label: 'Prior Milestones', milestoneOnly: true },
  { key: 'visitDoneAt', label: 'Visit Done At', milestoneOnly: true },
  { key: 'visitDoneNote', label: 'Visit Done Note', milestoneOnly: true },
  { key: 'meetingDoneAt', label: 'Meeting Done At', milestoneOnly: true },
  { key: 'meetingDoneNote', label: 'Meeting Done Note', milestoneOnly: true },
  { key: 'failedAt', label: 'Failed At', milestoneOnly: true },
  { key: 'failedNote', label: 'Failed Note', milestoneOnly: true },
]

const FIELD_KEYS = EXPORTABLE_FIELDS.map((f) => f.key)
const FIELD_INDEX = new Map(EXPORTABLE_FIELDS.map((f, i) => [f.key, i]))

/** Columns the prior-milestone preset ships with when the caller sends none. */
export const PRIOR_MILESTONE_PRESET_FIELDS = [
  'name',
  'phone',
  'alternatePhone',
  'email',
  'city',
  'source',
  'ownerName',
  'priorMilestones',
  'visitDoneAt',
  'visitDoneNote',
  'meetingDoneAt',
  'meetingDoneNote',
  'failedReason',
  'failedAt',
  'failedNote',
  'updatedAt',
]

/** Columns used when the caller sends no `fields` key at all. */
export const DEFAULT_EXPORT_FIELDS = EXPORTABLE_FIELDS.filter((f) => !f.milestoneOnly).map(
  (f) => f.key
)

export type ResolveFieldsResult =
  | { ok: true; fields: string[] }
  | { ok: false; message: string }

/**
 * Decide the exact columns an export produces.
 *
 * The caller's selection is authoritative: if `fields` is present it is the
 * complete column list, full stop. Only a *missing* `fields` key falls back to
 * a default set — an empty or all-invalid selection is an error rather than a
 * silent "export everything", which is what previously made a narrow selection
 * come back as a full-width CSV.
 */
export const resolveExportFields = (
  fields: unknown,
  options: { priorMilestoneOnly?: boolean } = {}
): ResolveFieldsResult => {
  if (fields === undefined) {
    return {
      ok: true,
      fields: options.priorMilestoneOnly ? [...PRIOR_MILESTONE_PRESET_FIELDS] : [...DEFAULT_EXPORT_FIELDS],
    }
  }

  if (!Array.isArray(fields)) {
    return { ok: false, message: '"fields" must be an array of field keys' }
  }

  if (fields.length === 0) {
    return { ok: false, message: 'Select at least one field to export' }
  }

  const unknown = fields.filter((f) => typeof f !== 'string' || !FIELD_INDEX.has(f))
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown export field(s): ${unknown.map(String).join(', ')}. Allowed: ${FIELD_KEYS.join(', ')}`,
    }
  }

  // De-duplicate, then sort into canonical column order.
  const selected = Array.from(new Set(fields as string[]))
  selected.sort((a, b) => (FIELD_INDEX.get(a) ?? 0) - (FIELD_INDEX.get(b) ?? 0))
  return { ok: true, fields: selected }
}

export const labelsFor = (fields: string[]): string[] =>
  fields.map((key) => EXPORTABLE_FIELDS.find((f) => f.key === key)?.label || key)

/** True when any selected column needs the statusNotes array. */
export const needsStatusNotes = (fields: string[]): boolean =>
  fields.some((key) => EXPORTABLE_FIELDS.find((f) => f.key === key)?.milestoneOnly)

/**
 * Most-recent statusNotes entry for a given disposition, or null when the lead
 * never reached that milestone.
 */
export const latestNoteFor = (lead: any, status: string) => {
  const matches = (lead?.statusNotes || []).filter((n: any) => n?.status === status)
  if (matches.length === 0) return null
  return matches.reduce((latest: any, current: any) => {
    const a = latest?.createdAt ? new Date(latest.createdAt).getTime() : 0
    const b = current?.createdAt ? new Date(current.createdAt).getTime() : 0
    return b >= a ? current : latest
  }, matches[0])
}

const isoOrEmpty = (value: any) => (value ? new Date(value).toISOString() : '')

/**
 * Build one export row containing exactly the requested columns — no more.
 * `fields` is assumed to have been validated by resolveExportFields.
 */
export const buildLeadRow = (lead: any, fields: string[]): Record<string, any> => {
  const row: Record<string, any> = {}

  // Only walk statusNotes when a milestone column was actually requested.
  const wantsMilestones = needsStatusNotes(fields)
  const visitDone = wantsMilestones ? latestNoteFor(lead, 'Visit Done') : null
  const meetingDone = wantsMilestones ? latestNoteFor(lead, 'Meeting Done') : null
  const failed = wantsMilestones ? latestNoteFor(lead, 'Failed') : null

  for (const field of fields) {
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
        row[field] = isoOrEmpty(lead[field])
        break
      case 'priorMilestones': {
        const hits: string[] = []
        if (visitDone) hits.push('Visit Done')
        if (meetingDone) hits.push('Meeting Done')
        row[field] = hits.join(', ')
        break
      }
      case 'visitDoneNote':
        row[field] = visitDone?.note || ''
        break
      case 'visitDoneAt':
        row[field] = isoOrEmpty(visitDone?.createdAt)
        break
      case 'meetingDoneNote':
        row[field] = meetingDone?.note || ''
        break
      case 'meetingDoneAt':
        row[field] = isoOrEmpty(meetingDone?.createdAt)
        break
      case 'failedNote':
        row[field] = failed?.note || ''
        break
      case 'failedAt':
        row[field] = isoOrEmpty(failed?.createdAt)
        break
      default:
        row[field] = lead[field] ?? ''
    }
  }

  return row
}

const escapeCell = (value: any): string => {
  const stringValue = String(value ?? '')
  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }
  return stringValue
}

/** Render rows as CSV with one column per requested field, in field order. */
export const toCsv = (rows: Record<string, any>[], fields: string[]): string => {
  const header = labelsFor(fields).map(escapeCell).join(',')
  const body = rows.map((row) => fields.map((field) => escapeCell(row[field])).join(','))
  return [header, ...body].join('\n')
}
