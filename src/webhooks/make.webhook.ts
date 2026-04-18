import { Request, Response, NextFunction } from 'express'
import { Lead } from '../models/Lead'
import { DeletedLeadPhone } from '../models/DeletedLeadPhone'
import { DeletedLeadExternalId } from '../models/DeletedLeadExternalId'
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

    // Normalize phone — strip non-digits AND leading zeros, then take last 10 digits.
    // This MUST match the normalization used in blockDeletedPhones() so that
    // tombstones created on delete match what we look up here.
    const digitsOnly = phone.replace(/\D/g, '').replace(/^0+/, '')
    const phoneTail = digitsOnly.length <= 10 ? digitsOnly : digitsOnly.slice(-10)

    // Step 1 — look up an existing lead by externalId / metaLeadId / phone tail.
    const existingLead =
      (externalId ? await Lead.findOne({ externalId }).exec() : null) ||
      (externalId ? await Lead.findOne({ metaLeadId: externalId }).exec() : null) ||
      (phoneTail
        ? await Lead.findOne({ phone: { $regex: `${phoneTail}$` } }).exec()
        : null)

    // Step 2 — if the lead already exists, IT IS IMMUTABLE from the webhook's perspective.
    // The rep may have edited disposition, notes, owner, source, etc. The scheduled
    // Make.com scenario will re-send this same lead on every run — we must not
    // reset or overwrite ANY of those fields. Just acknowledge and move on.
    if (existingLead) {
      logger.info('Make lead ignored — already exists (no changes applied)', {
        leadId: String(existingLead._id),
        externalId,
        phoneTail,
      })
      return res.status(200).json({
        success: true,
        data: {
          leadId: String(existingLead._id),
          created: false,
          unchanged: true,
          reason: 'lead_already_exists',
        },
      })
    }

    // Step 3 — lead doesn't exist. Check the tombstone blocklist to see whether it
    // was previously deleted by a manager. Deleted leads must NEVER be re-imported
    // by Make.com, regardless of how many times the scenario runs.
    const tombstonedByExternalId = externalId
      ? await DeletedLeadExternalId.findOne({ externalId }).lean()
      : null
    const tombstonedByPhone = phoneTail
      ? await DeletedLeadPhone.findOne({ phone: phoneTail }).lean()
      : null

    if (tombstonedByExternalId || tombstonedByPhone) {
      logger.info('Make lead suppressed (previously deleted)', {
        externalId,
        phoneTail,
        reason: tombstonedByExternalId ? 'externalId' : 'phone',
      })
      return res.status(200).json({
        success: true,
        data: {
          suppressed: true,
          reason: tombstonedByExternalId
            ? 'lead_previously_deleted_by_external_id'
            : 'lead_previously_deleted_by_phone',
        },
      })
    }

    // Step 4 — truly new lead. Create it fresh.
    const activityNote = formLabel
      ? `${source} lead form: ${formLabel}`
      : campaignLabel
        ? `${source} campaign: ${campaignLabel}`
        : `${source} lead`

    const lead = await Lead.create({
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
    })

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

    void notifyNewLeadCreated(lead).catch(() => null)

    logger.info('Make lead created', {
      leadId: String(lead._id),
      source,
      externalId,
    })

    return res.status(201).json({
      success: true,
      data: {
        leadId: String(lead._id),
        created: true,
      },
    })
  } catch (err) {
    next(err)
  }
}
