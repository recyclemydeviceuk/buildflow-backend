import mongoose from 'mongoose'
import { QueueItem } from '../models/QueueItem'
import { Lead } from '../models/Lead'
import { Settings } from '../models/Settings'
import { emitToTeam, emitToUser } from '../config/socket'
import { addOfferTimeout } from '../utils/dateHelpers'
import { logger } from '../utils/logger'

export const offerLeadToRep = async (queueItemId: string, repId: string, repName: string) => {
  const settings = await Settings.findOne()
  const timeoutSec = settings?.leadRouting?.offerTimeout || 60

  const item = await QueueItem.findByIdAndUpdate(
    queueItemId,
    {
      status: 'offered',
      offeredTo: repId,
      offeredToName: repName,
      offeredAt: new Date(),
      offerExpiresAt: addOfferTimeout(timeoutSec),
    },
    { new: true }
  )
  if (!item) return null

  emitToUser(repId, 'queue:lead_offered', {
    queueItemId: item._id,
    leadId: item.leadId,
    leadName: item.leadName,
    phone: item.phone,
    city: item.city,
    source: item.source,
    expiresAt: item.offerExpiresAt,
  })

  return item
}

export const acceptLeadOffer = async (queueItemId: string, repId: string, repName: string) => {
  const item = await QueueItem.findOne({
    _id: new mongoose.Types.ObjectId(queueItemId),
    offeredTo: repId,
    status: 'offered',
  })

  if (!item) return null
  if (item.offerExpiresAt && item.offerExpiresAt < new Date()) {
    await expireOffer(queueItemId)
    return null
  }

  item.status = 'assigned'
  item.assignedTo = new mongoose.Types.ObjectId(repId) as unknown as mongoose.Types.ObjectId
  item.assignedToName = repName
  item.assignedAt = new Date()
  await item.save()

  await Lead.findByIdAndUpdate(item.leadId, { owner: repId, ownerName: repName })

  emitToTeam('all', 'queue:lead_assigned', { queueItemId, repId, repName })
  return item
}

export const expireOffer = async (queueItemId: string) => {
  const item = await QueueItem.findByIdAndUpdate(
    queueItemId,
    { status: 'waiting', segment: 'Timed Out', offeredTo: null, offeredToName: null, offeredAt: null, offerExpiresAt: null },
    { new: true }
  )

  if (item) {
    emitToTeam('all', 'queue:offer_expired', { queueItemId })
  }
  return item
}

export const skipQueueItem = async (queueItemId: string, repId: string) => {
  const settings = await Settings.findOne()
  const skipLimit = settings?.leadRouting?.skipLimit || 3

  const item = await QueueItem.findById(queueItemId)
  if (!item) return null

  item.skipCount += 1
  if (item.skipCount >= skipLimit) {
    item.segment = 'Escalated'
    emitToTeam('all', 'queue:lead_escalated', { queueItemId, leadId: item.leadId })
  } else {
    item.segment = 'Skipped'
  }
  item.status = 'waiting'
  item.offeredTo = null
  item.offeredToName = null
  await item.save()

  await Lead.findByIdAndUpdate(item.leadId, { $inc: { skipCount: 1 } })
  return item
}

export const addLeadToQueue = async (leadId: string, source: string, urgency = 1) => {
  const lead = await Lead.findById(leadId)
  if (!lead) return null

  const existing = await QueueItem.findOne({ leadId: new mongoose.Types.ObjectId(leadId), status: { $in: ['waiting', 'offered'] } })
  if (existing) return existing

  const item = await QueueItem.create({
    leadId: lead._id,
    leadName: lead.name,
    phone: lead.phone,
    city: lead.city,
    source,
    segment: 'Unassigned',
    status: 'waiting',
    urgency,
  })

  await Lead.findByIdAndUpdate(leadId, { isInQueue: true })
  emitToTeam('all', 'queue:lead_added', { queueItemId: item._id, leadId })
  return item
}
