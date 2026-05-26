import { emitToTeam, emitToUser } from '../config/socket'

export const notifyLeadIncoming = (leadId: string, leadName: string, phone: string, city: string, source: string, queueItemId: string) => {
  emitToTeam('all', 'lead:incoming', { leadId, leadName, phone, city, source, queueItemId })
}

// Unified "lead just got an owner" fan-out. Every code path that mutates
// Lead.owner MUST funnel through here so the assignee gets:
//   • a per-user nudge (`lead:assigned_to_you`) — used by Layout for the popup
//     and by LeadList for instant re-fetch
//   • a team broadcast (`lead:assigned`) — keeps the manager's "Unassigned"
//     view and any peer dashboards in sync.
// Passing leadName/phone/city/source lets the receiving rep see the lead in
// the popup without an extra HTTP round-trip.
export const notifyLeadAssigned = (
  leadId: string,
  repId: string,
  repName: string,
  extras: { leadName?: string; phone?: string; city?: string; source?: string } = {}
) => {
  const payload = {
    leadId,
    assignedTo: repId,
    assignedToName: repName,
    leadName: extras.leadName,
    phone: extras.phone,
    city: extras.city,
    source: extras.source,
  }
  emitToTeam('all', 'lead:assigned', payload)
  emitToUser(repId, 'lead:assigned_to_you', payload)
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
