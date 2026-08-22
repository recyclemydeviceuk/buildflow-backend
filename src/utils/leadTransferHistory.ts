export const LEAD_TRANSFER_ACTIONS = [
  'lead.assigned',
  'lead.transferred',
  'lead.unassigned',
  'lead.assignment_declined',
  'lead.bulk_updated',
  'LEAD_ASSIGNED',
] as const

export type LeadTransferType = 'assignment' | 'transfer' | 'unassignment'
export type LeadTransferSource = 'direct' | 'bulk' | 'queue' | 'assistant' | 'call' | 'declined' | 'legacy'

type AuditLike = {
  _id?: unknown
  actor?: unknown
  actorName?: unknown
  actorRole?: unknown
  action?: unknown
  entity?: unknown
  entityId?: unknown
  before?: unknown
  after?: unknown
  metadata?: unknown
  createdAt?: unknown
}

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const asId = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  const stringValue = String(value)
  return stringValue === '[object Object]' ? null : stringValue
}

const readOwner = (value: unknown): { id: string | null; name: string } | null => {
  const record = asRecord(value)
  const id = asId(record.owner)
  const name = String(record.ownerName || '').trim()
  if (!id && !name) return null
  return { id, name: name || 'Unknown representative' }
}

const ownerIdentity = (owner: { id: string | null; name: string } | null): string | null =>
  owner ? owner.id || `name:${owner.name.toLowerCase()}` : null

export const getLeadOwnershipAction = (
  before: unknown,
  after: unknown
): 'lead.assigned' | 'lead.transferred' | 'lead.unassigned' | null => {
  const from = readOwner(before)
  const to = readOwner(after)
  const fromIdentity = ownerIdentity(from)
  const toIdentity = ownerIdentity(to)

  if (fromIdentity === toIdentity) return null
  if (!fromIdentity && toIdentity) return 'lead.assigned'
  if (fromIdentity && !toIdentity) return 'lead.unassigned'
  return 'lead.transferred'
}

export interface LeadTransferHistoryRow {
  id: string
  leadId: string
  leadName: string
  leadPhone: string
  performedBy: {
    id: string | null
    name: string
    role: string
  }
  from: { id: string | null; name: string } | null
  to: { id: string | null; name: string } | null
  type: LeadTransferType
  source: LeadTransferSource
  action: string
  createdAt: string
}

export const normalizeLeadTransferLog = (log: AuditLike): LeadTransferHistoryRow | null => {
  const before = asRecord(log.before)
  const after = asRecord(log.after)
  const metadata = asRecord(log.metadata)
  const action = String(log.action || '')
  const isLegacyQueueAssignment = action === 'queue.assigned' && String(log.entity || '') === 'QueueItem'
  const effectiveAfter = isLegacyQueueAssignment
    ? { ...after, owner: after.assignedTo, ownerName: after.assignedToName }
    : after
  const from = readOwner(before)
  const to = readOwner(effectiveAfter)
  const ownershipAction = getLeadOwnershipAction(before, effectiveAfter)

  // Legacy assignment records can have a partial `after`, but they still need
  // a real owner transition. Generic bulk updates are excluded unless owner
  // actually changed.
  if (!ownershipAction) return null

  const type: LeadTransferType =
    ownershipAction === 'lead.assigned'
      ? 'assignment'
      : ownershipAction === 'lead.unassigned'
        ? 'unassignment'
        : 'transfer'

  const sourceValue = String(metadata.transferSource || '')
  const source: LeadTransferSource =
    sourceValue === 'direct' ||
    sourceValue === 'bulk' ||
    sourceValue === 'queue' ||
    sourceValue === 'assistant' ||
    sourceValue === 'call' ||
    sourceValue === 'declined'
      ? sourceValue
      : action === 'lead.bulk_updated'
        ? 'bulk'
        : action === 'lead.assignment_declined'
          ? 'declined'
          : action.startsWith('queue.')
            ? 'queue'
            : action === 'LEAD_ASSIGNED'
              ? 'legacy'
              : 'direct'

  const createdAt = log.createdAt ? new Date(log.createdAt as any) : new Date(0)

  return {
    id: String(log._id || ''),
    leadId: String(
      (isLegacyQueueAssignment ? after.leadId : null) || log.entityId || after._id || before._id || ''
    ),
    leadName: String(after.name || after.leadName || before.name || metadata.leadName || 'Unknown lead'),
    leadPhone: String(after.phone || before.phone || metadata.leadPhone || ''),
    performedBy: {
      id: asId(log.actor),
      name: String(log.actorName || 'Unknown user'),
      role: String(log.actorRole || 'unknown'),
    },
    from,
    to,
    type,
    source,
    action,
    createdAt: isNaN(createdAt.getTime()) ? '' : createdAt.toISOString(),
  }
}
