import { Lead } from '../models/Lead'
import { emitToTeam } from '../config/socket'
import { WebsiteLeadPayload } from '../types/webhook.types'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'

export const processWebsiteLead = async (payload: WebsiteLeadPayload): Promise<void> => {
  try {
    const { name, phone, email, city, campaign, budget, message, utmSource, utmMedium, utmCampaign } = payload

    const normalizedPhone = phone.replace(/\D/g, '')
    const existingLead =
      (campaign ? await Lead.findOne({ campaign: campaign, phone }).exec() : null) ||
      (normalizedPhone
        ? await Lead.findOne({ phone: { $regex: `${normalizedPhone.slice(-10)}$` } }).exec()
        : null)

    const lead =
      existingLead ||
      (await Lead.create({
        name,
        phone,
        email: email || null,
        city: city || 'Unknown',
        source: 'Website',
        disposition: 'New',
        campaign: campaign || null,
        budget: budget || null,
        lastActivityNote: message || null,
        utmSource: utmSource || null,
        utmMedium: utmMedium || null,
        utmCampaign: utmCampaign || null,
        lastActivity: new Date(),
      }))

    lead.name = lead.name || name
    lead.phone = lead.phone || phone
    lead.email = lead.email || email || null
    lead.city = lead.city && lead.city !== 'Unknown' ? lead.city : city || 'Unknown'
    lead.source = 'Website'
    lead.campaign = campaign || lead.campaign || null
    lead.budget = budget || lead.budget || null
    lead.lastActivityNote = message || lead.lastActivityNote || null
    lead.utmSource = utmSource || lead.utmSource || null
    lead.utmMedium = utmMedium || lead.utmMedium || null
    lead.utmCampaign = utmCampaign || lead.utmCampaign || null
    lead.lastActivity = new Date()
    lead.isInQueue = false
    await lead.save()

    emitToTeam('all', 'lead:incoming', {
      lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'Website', owner: lead.owner || null },
    })

    if (!existingLead) {
      void notifyNewLeadCreated(lead).catch(() => null)
    }

    logger.info('Website lead created', { leadId: lead._id })
  } catch (err) {
    logger.error('processWebsiteLead error', err)
    throw err
  }
}
