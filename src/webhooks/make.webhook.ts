import { Request, Response, NextFunction } from 'express'
import { Lead } from '../models/Lead'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'

interface MakeLeadPayload {
  name?: string
  phone?: string
  alternatePhone?: string
  email?: string
  city?: string
  source?: string
  formName?: string
  formId?: string
  campaignId?: string
  campaignName?: string
  adId?: string
  adName?: string
  adsetId?: string
  adsetName?: string
  externalId?: string
  createdTime?: string
  rawFields?: Record<string, string>
}

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

export const handleMakeLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configuredToken = process.env.MAKE_WEBHOOK_TOKEN
    const providedToken =
      cleanString(req.get('x-make-token')) ||
      cleanString(req.query.token) ||
      cleanString((req.body as any)?.token)

    if (configuredToken && providedToken !== configuredToken) {
      logger.warn('Make webhook: invalid token')
      return res.status(401).json({ success: false, message: 'Invalid webhook token' })
    }

    const payload = (req.body || {}) as MakeLeadPayload

    const name = cleanString(payload.name) || 'Unknown'
    const phone = cleanString(payload.phone)
    const email = cleanString(payload.email) || null
    const city = cleanString(payload.city) || 'Unknown'
    const source = cleanString(payload.source) || 'Meta'
    const externalId = cleanString(payload.externalId) || undefined
    const formLabel = cleanString(payload.formName) || cleanString(payload.formId) || undefined
    const campaignLabel = cleanString(payload.campaignName) || cleanString(payload.campaignId) || undefined

    if (!phone) {
      logger.warn('Make webhook: payload missing phone', { externalId })
      return res.status(400).json({ success: false, message: 'phone is required' })
    }

    const normalizedPhone = phone.replace(/\D/g, '')
    const phoneTail = normalizedPhone.slice(-10)

    const existingLead =
      (externalId ? await Lead.findOne({ externalId }).exec() : null) ||
      (externalId ? await Lead.findOne({ metaLeadId: externalId }).exec() : null) ||
      (phoneTail
        ? await Lead.findOne({ phone: { $regex: `${phoneTail}$` } }).exec()
        : null)

    const activityNote = formLabel
      ? `${source} lead form: ${formLabel}`
      : campaignLabel
        ? `${source} campaign: ${campaignLabel}`
        : `${source} lead`

    const lead =
      existingLead ||
      (await Lead.create({
        name,
        phone,
        alternatePhone: cleanString(payload.alternatePhone) || null,
        email,
        city,
        source,
        disposition: 'New',
        externalId: externalId || null,
        metaLeadId: source.toLowerCase() === 'meta' ? externalId || null : null,
        campaign: campaignLabel || null,
        campaignId: cleanString(payload.campaignId) || cleanString(payload.formId) || null,
        lastActivity: payload.createdTime ? new Date(payload.createdTime) : new Date(),
        lastActivityNote: activityNote,
        websiteFormData: payload.rawFields && typeof payload.rawFields === 'object' ? payload.rawFields : null,
        isInQueue: false,
      }))

    lead.name = lead.name && lead.name !== 'Unknown' ? lead.name : name
    lead.phone = lead.phone || phone
    if (!lead.email && email) lead.email = email
    if ((!lead.city || lead.city === 'Unknown') && city) lead.city = city
    lead.source = source
    if (externalId) {
      lead.externalId = externalId
      if (source.toLowerCase() === 'meta') lead.metaLeadId = externalId
    }
    if (campaignLabel) lead.campaign = campaignLabel
    if (cleanString(payload.campaignId) || cleanString(payload.formId)) {
      lead.campaignId = cleanString(payload.campaignId) || cleanString(payload.formId) || lead.campaignId
    }
    lead.lastActivity = payload.createdTime ? new Date(payload.createdTime) : new Date()
    lead.lastActivityNote = activityNote
    if (payload.rawFields && typeof payload.rawFields === 'object') {
      lead.websiteFormData = { ...(lead.websiteFormData || {}), ...payload.rawFields }
    }
    lead.isInQueue = false
    await lead.save()

    emitToTeam('all', 'lead:incoming', {
      lead: {
        id: lead._id,
        name: lead.name,
        phone: lead.phone,
        city: lead.city,
        source: lead.source,
        owner: lead.owner || null,
      },
    })

    if (!existingLead) {
      void notifyNewLeadCreated(lead).catch(() => null)
    }

    logger.info('Make lead upserted', {
      leadId: lead._id,
      source,
      externalId,
      created: !existingLead,
    })

    return res.status(200).json({
      success: true,
      data: {
        leadId: String(lead._id),
        created: !existingLead,
      },
    })
  } catch (err) {
    next(err)
  }
}
