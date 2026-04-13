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

    const lead =
      existingLead ||
      (await Lead.create({
        name, phone, email, city,
        source: 'Google ADS',
        disposition: 'New',
        googleClickId: gclid,
        lastActivity: new Date(),
      }))

    lead.name = lead.name || name
    lead.phone = lead.phone || phone
    lead.email = lead.email || email
    lead.city = lead.city && lead.city !== 'Unknown' ? lead.city : city
    lead.source = 'Google ADS'
    lead.googleClickId = gclid || lead.googleClickId || null
    lead.lastActivity = new Date()
    lead.isInQueue = false
    await lead.save()

    emitToTeam('all', 'lead:incoming', {
      lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'Google ADS', owner: lead.owner || null },
    })

    if (!existingLead) {
      void notifyNewLeadCreated(lead).catch(() => null)
    }

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
