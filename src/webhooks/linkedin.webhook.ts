import { Lead } from '../models/Lead'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'

export const processLinkedInLead = async (leadData: Record<string, string>): Promise<void> => {
  try {
    const name = leadData['firstName'] && leadData['lastName']
      ? `${leadData['firstName']} ${leadData['lastName']}`
      : leadData['name'] || 'Unknown'
    const phone = leadData['phoneNumber'] || leadData['phone'] || ''
    const email = leadData['email'] || null
    const city = leadData['city'] || 'Unknown'
    const leadId = leadData['leadId'] || null

    if (!phone && !email) {
      logger.warn('LinkedIn webhook: lead has no contact info', { leadId })
      return
    }

    const normalizedPhone = phone.replace(/\D/g, '')
    const existingLead =
      (leadId ? await Lead.findOne({ linkedInLeadId: leadId }).exec() : null) ||
      (normalizedPhone
        ? await Lead.findOne({ phone: { $regex: `${normalizedPhone.slice(-10)}$` } }).exec()
        : null)

    const lead =
      existingLead ||
      (await Lead.create({
        name, phone: phone || 'N/A', email, city,
        source: 'LinkedIn',
        disposition: 'New',
        linkedInLeadId: leadId,
        lastActivity: new Date(),
      }))

    lead.name = lead.name || name
    lead.phone = lead.phone || phone || 'N/A'
    lead.email = lead.email || email
    lead.city = lead.city && lead.city !== 'Unknown' ? lead.city : city
    lead.source = 'LinkedIn'
    lead.linkedInLeadId = leadId || lead.linkedInLeadId || null
    lead.lastActivity = new Date()
    lead.isInQueue = false
    await lead.save()

    emitToTeam('all', 'lead:incoming', {
      lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'LinkedIn', owner: lead.owner || null },
    })

    if (!existingLead) {
      void notifyNewLeadCreated(lead).catch(() => null)
    }

    logger.info('LinkedIn lead created', { leadId: lead._id })
  } catch (err) {
    logger.error('processLinkedInLead error', err)
  }
}
