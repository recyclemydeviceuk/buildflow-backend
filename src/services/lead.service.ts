import mongoose from 'mongoose'
import { Lead } from '../models/Lead'
import { QueueItem } from '../models/QueueItem'
import { logAction } from './auditLog.service'
import { parsePagination } from '../utils/paginate'
import { LeadFilters } from '../types/lead.types'
import { emitToTeam } from '../config/socket'

export const getLeadsWithFilters = async (filters: LeadFilters) => {
  const { page, limit, skip } = parsePagination(filters.page, filters.limit)

  const query: Record<string, unknown> = {}
  if (filters.search) query.$text = { $search: filters.search }
  if (filters.source) query.source = filters.source
  if (filters.disposition) query.disposition = filters.disposition
  if (filters.owner) query.owner = new mongoose.Types.ObjectId(filters.owner)
  if (filters.city) query.city = filters.city
  if (filters.isInQueue !== undefined) query.isInQueue = filters.isInQueue
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {
      ...(filters.dateFrom && { $gte: new Date(filters.dateFrom) }),
      ...(filters.dateTo && { $lte: new Date(filters.dateTo) }),
    }
  }

  const [leads, total] = await Promise.all([
    Lead.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Lead.countDocuments(query),
  ])

  return { leads, total, page, limit }
}

export const assignLeadToUser = async (
  leadId: string,
  userId: string,
  userName: string,
  actorId: string,
  actorName: string,
  actorRole: string
) => {
  const before = await Lead.findById(leadId).lean()
  const lead = await Lead.findByIdAndUpdate(
    leadId,
    { owner: userId, ownerName: userName },
    { new: true }
  )
  if (!lead) return null

  await logAction({
    actorId, actorName, actorRole,
    action: 'LEAD_ASSIGNED',
    entity: 'Lead',
    entityId: leadId,
    before: before as Record<string, unknown>,
    after: { owner: userId, ownerName: userName },
  })

  emitToTeam('all', 'lead:assigned', { leadId, assignedTo: userId, assignedToName: userName })
  return lead
}

export const updateLeadDisposition = async (
  leadId: string,
  disposition: string,
  note: string | undefined,
  actorId: string,
  actorName: string,
  actorRole: string
) => {
  const before = await Lead.findById(leadId).lean()
  const lead = await Lead.findByIdAndUpdate(
    leadId,
    {
      disposition,
      lastActivity: new Date(),
      ...(note && { lastActivityNote: note }),
    },
    { new: true }
  )
  if (!lead) return null

  await logAction({
    actorId, actorName, actorRole,
    action: 'DISPOSITION_UPDATED',
    entity: 'Lead',
    entityId: leadId,
    before: { disposition: (before as Record<string, unknown>)?.disposition },
    after: { disposition },
  })

  if (['Agreement Done', 'Failed'].includes(disposition)) {
    await QueueItem.findOneAndUpdate(
      { leadId: new mongoose.Types.ObjectId(leadId), status: { $in: ['waiting', 'offered'] } },
      { status: 'completed' }
    )
    await Lead.findByIdAndUpdate(leadId, { isInQueue: false })
  }

  return lead
}
