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

    // If the lead already exists, don't touch any rep-curated fields.
    // Only record activity. See website.webhook.ts for the same pattern.
    if (existingLead) {
      await Lead.updateOne(
        { _id: existingLead._id },
        { $set: { lastActivity: new Date() } }
      )
      emitToTeam('all', 'lead:incoming', {
        lead: {
          id: existingLead._id,
          name: existingLead.name,
          phone: existingLead.phone,
          city: existingLead.city,
          source: existingLead.source,
          owner: existingLead.owner || null,
        },
      })
      logger.info('LinkedIn webhook — lead already exists, only lastActivity bumped', {
        leadId: String(existingLead._id),
      })
      return
    }

    // Truly new lead.
    const lead = await Lead.create({
      name,
      phone: phone || 'N/A',
      email,
      city,
      source: 'LinkedIn',
      disposition: 'New',
      linkedInLeadId: leadId,
      lastActivity: new Date(),
      isInQueue: false,
    })

    emitToTeam('all', 'lead:incoming', {
      lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'LinkedIn', owner: lead.owner || null },
    })

    void notifyNewLeadCreated(lead).catch(() => null)

    logger.info('LinkedIn lead created', { leadId: lead._id })
  } catch (err) {
    logger.error('processLinkedInLead error', err)
  }
}
