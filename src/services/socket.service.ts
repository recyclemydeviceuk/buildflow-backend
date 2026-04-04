import { emitToTeam, emitToUser } from '../config/socket'

export const notifyLeadIncoming = (leadId: string, leadName: string, phone: string, city: string, source: string, queueItemId: string) => {
  emitToTeam('all', 'lead:incoming', { leadId, leadName, phone, city, source, queueItemId })
}

export const notifyLeadAssigned = (leadId: string, repId: string, repName: string) => {
  emitToTeam('all', 'lead:assigned', { leadId, repId, repName })
  emitToUser(repId, 'lead:assigned_to_you', { leadId, repName })
}

export const notifyCallStatusUpdated = (callId: string, callSid: string, status: string, outcome: string, duration: number) => {
  emitToTeam('all', 'call:status_updated', { callId, callSid, status, outcome, duration })
}

export const notifyQueueOfferExpired = (queueItemId: string, repId: string) => {
  emitToUser(repId, 'queue:offer_expired', { queueItemId })
  emitToTeam('all', 'queue:offer_expired', { queueItemId })
}

export const notifyReminderDue = (reminderId: string, ownerId: string, title: string, leadId: string) => {
  emitToUser(ownerId, 'reminder:due', { reminderId, title, leadId })
}
