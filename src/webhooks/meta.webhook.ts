import { Lead } from '../models/Lead'
import { Integration } from '../models/Integration'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'
import { fetchMetaLeadData, type MetaLeadField, type MetaLeadPayload } from '../services/meta.service'

const fieldValue = (fields: MetaLeadField[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const f = fields.find((f) => f.name.toLowerCase() === name.toLowerCase())
    if (f?.values?.[0]) return f.values[0]
  }
  return undefined
}

export const upsertMetaLeadPayload = async (
  payload: MetaLeadPayload,
  formIdOverride?: string
): Promise<{ imported: boolean; created: boolean; leadId?: string; reason?: string }> => {
  const fields = payload.field_data || []
  const leadgenId = payload.id
  const formId = formIdOverride || payload.form_id

  const name = fieldValue(fields, 'full_name', 'name') || 'Unknown'
  const phone = fieldValue(fields, 'phone_number', 'mobile_number', 'phone') || ''
  const email = fieldValue(fields, 'email') || null
  const city = fieldValue(fields, 'city', 'location') || 'Unknown'

  if (!phone) {
    logger.warn('Meta webhook: lead has no phone', { leadgenId })
    return { imported: false, created: false, reason: 'missing_phone' }
  }

  const normalizedPhone = phone.replace(/\D/g, '')
  const existingLead =
    (await Lead.findOne({ metaLeadId: leadgenId }).exec()) ||
    (normalizedPhone
      ? await Lead.findOne({ phone: { $regex: `${normalizedPhone.slice(-10)}$` } }).exec()
      : null)

  const lead =
    existingLead ||
    (await Lead.create({
      name,
      phone,
      email,
      city,
      source: 'Meta',
      disposition: 'New',
      metaLeadId: leadgenId,
      campaignId: formId || null,
      lastActivity: payload.created_time ? new Date(payload.created_time) : new Date(),
    }))

  lead.name = lead.name || name
  lead.phone = lead.phone || phone
  lead.email = lead.email || email
  lead.city = lead.city && lead.city !== 'Unknown' ? lead.city : city
  lead.source = 'Meta'
  lead.metaLeadId = leadgenId
  if (formId) lead.campaignId = formId
  lead.lastActivity = payload.created_time ? new Date(payload.created_time) : new Date()
  lead.lastActivityNote = formId ? `Meta lead form: ${formId}` : lead.lastActivityNote
  lead.isInQueue = false
  await lead.save()

  emitToTeam('all', 'lead:incoming', {
    lead: { id: lead._id, name: lead.name, phone: lead.phone, city: lead.city, source: 'Meta', owner: lead.owner || null },
  })

  if (!existingLead) {
    void notifyNewLeadCreated(lead).catch(() => null)
  }

  logger.info('Meta lead upserted', { leadId: lead._id, leadgenId, created: !existingLead })

  return { imported: true, created: !existingLead, leadId: String(lead._id) }
}

export const processMetaLeadgen = async (leadgenId: string, formId?: string): Promise<void> => {
  try {
    const integration = await Integration.findOne({ provider: 'meta', status: 'connected' }).select('+accessToken')
    if (!integration?.accessToken) {
      logger.warn('Meta webhook: no connected Meta integration')
      return
    }

    const payload = await fetchMetaLeadData(
      leadgenId,
      integration.accessToken,
      integration.appSecret || process.env.META_APP_SECRET || undefined
    )

    await upsertMetaLeadPayload(payload, formId)
  } catch (err) {
    logger.error('processMetaLeadgen error', err)
  }
}
