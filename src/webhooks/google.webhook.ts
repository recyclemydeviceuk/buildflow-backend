import axios from 'axios'
import { Lead } from '../models/Lead'
import { Integration } from '../models/Integration'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'

export const processGoogleLeadForm = async (gclid: string, formData: Record<string, string>): Promise<void> => {
  try {
    const name = formData['full_name'] || formData['name'] || 'Unknown'
    const phone = formData['phone_number'] || formData['phone'] || ''
    const email = formData['email'] || null
    const city = formData['city'] || 'Unknown'

    if (!phone) {
      logger.warn('Google webhook: lead has no phone', { gclid })
      return
    }

    const normalizedPhone = phone.replace(/\D/g, '')
    const existingLead =
      (gclid ? await Lead.findOne({ googleClickId: gclid }).exec() : null) ||
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
      logger.info('Google webhook — lead already exists, only lastActivity bumped', {
        leadId: String(existingLead._id),
      })
      return
    }

    // Truly new lead.
    const lead = await Lead.create({
      name,
      phone,
      email,
      city,
      source: 'Google ADS',
      disposition: 'New',
      googleClickId: gclid,
      lastActivity: new Date(),
      isInQueue: false,
    })

    emitToTeam('all', 'lead:incoming', {
      lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'Google ADS', owner: lead.owner || null },
    })

    void notifyNewLeadCreated(lead).catch(() => null)

    logger.info('Google lead created', { leadId: lead._id, gclid })
  } catch (err) {
    logger.error('processGoogleLeadForm error', err)
  }
}

export const refreshGoogleToken = async (): Promise<string | null> => {
  try {
    const integration = await Integration.findOne({ provider: 'google', status: 'connected' }).select('+refreshToken')
    if (!integration?.refreshToken) return null

    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token',
    })

    const { access_token, expires_in } = res.data
    await Integration.findOneAndUpdate(
      { provider: 'google' },
      { accessToken: access_token, tokenExpiresAt: new Date(Date.now() + expires_in * 1000) }
    )

    return access_token
  } catch (err) {
    logger.error('refreshGoogleToken error', err)
    return null
  }
}
