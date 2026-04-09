import { Request, Response, NextFunction } from 'express'
import { emitToTeam } from '../config/socket'
import { processExotelCallStatus } from '../webhooks/exotel.webhook'
import { processExoVoiceAnalyzeResult } from '../webhooks/exotelAnalyze.webhook'
import { processExotelSmsStatus } from '../webhooks/exotelSms.webhook'
import { processMetaLeadgen } from '../webhooks/meta.webhook'
import { verifyMetaWebhookSignature } from '../services/meta.service'
import { processWebsiteLead } from '../webhooks/website.webhook'
import { ExotelCallStatusPayload, ExotelSMSStatusCallbackPayload, ExoVoiceAnalyzeWebhookPayload } from '../types/exotel.types'
import { logger } from '../utils/logger'

const parseWebsiteLeadPayload = (payload: Record<string, any>) => {
  const normalizeFieldEntry = (key: string, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        key,
        label: String((value as any).title || (value as any).label || key).toLowerCase(),
        type: String((value as any).type || '').toLowerCase(),
        value: String((value as any).value || (value as any).raw_value || '').trim(),
      }
    }

    return {
      key,
      label: String(key).toLowerCase(),
      type: '',
      value: String(Array.isArray(value) ? value.join(', ') : value || '').trim(),
    }
  }

  const nestedFields = Array.isArray(payload?.fields)
    ? payload.fields.map((field, index) =>
        normalizeFieldEntry(String(field?.id || field?.custom_id || field?.title || field?.label || index), field)
      )
    : payload?.fields && typeof payload.fields === 'object'
      ? Object.entries(payload.fields).map(([key, value]) => normalizeFieldEntry(key, value))
      : []

  const reservedTopLevelKeys = new Set([
    'fields',
    'token',
    'name',
    'phone',
    'email',
    'city',
    'campaign',
    'budget',
    'message',
    'form_name',
    'formName',
    'form',
    'utmSource',
    'utm_source',
    'utmMedium',
    'utm_medium',
    'utmCampaign',
    'utm_campaign',
  ])

  const topLevelFields = Object.entries(payload)
    .filter(([key]) => !reservedTopLevelKeys.has(key))
    .map(([key, value]) => normalizeFieldEntry(key, value))

  const fieldEntries = [...nestedFields, ...topLevelFields]
  const populatedFieldEntries = fieldEntries.filter((entry) => entry.value)
  const isPhoneValue = (value?: string) => value ? value.replace(/\D/g, '').length >= 10 : false
  const isEmailValue = (value?: string) => value ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) : false

  const findField = (...names: string[]) => {
    const normalizedNames = names.map((name) => name.toLowerCase())
    const exact = populatedFieldEntries.find((entry) => normalizedNames.includes(entry.key.toLowerCase()) || normalizedNames.includes(entry.label))
    if (exact?.value) return exact.value

    const partial = populatedFieldEntries.find((entry) =>
      normalizedNames.some((name) => entry.key.toLowerCase().includes(name) || entry.label.includes(name))
    )
    return partial?.value || ''
  }

  const excludeValues = (...values: Array<string | undefined>) => {
    const blocked = new Set(
      values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
    )

    return populatedFieldEntries.filter((entry) => !blocked.has(entry.value.trim().toLowerCase()))
  }

  const findByType = (types: string[], entries = populatedFieldEntries) =>
    entries.find((entry) => types.includes(entry.type))

  const findByValue = (predicate: (value: string) => boolean, entries = populatedFieldEntries) =>
    entries.find((entry) => predicate(entry.value))

  const findLikelyName = (entries = populatedFieldEntries) =>
    entries.find((entry) => {
      if (!entry.value) return false
      if (entry.type && ['email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'radio'].includes(entry.type)) return false
      if (isEmailValue(entry.value) || isPhoneValue(entry.value)) return false
      if (entry.value.length < 2) return false
      return /[a-z]/i.test(entry.value)
    })

  const findLikelyCity = (entries = populatedFieldEntries) =>
    entries.find((entry) => {
      if (!entry.value) return false
      if (isEmailValue(entry.value) || isPhoneValue(entry.value)) return false
      if (entry.type && ['email', 'tel', 'number', 'textarea'].includes(entry.type)) return false
      const normalized = entry.value.toLowerCase()
      if (/(sq\s*ft|sqft|plot|construction|requirement|budget)/i.test(normalized)) return false
      return /[a-z]/i.test(entry.value)
    })

  const findLikelyMessage = (entries = populatedFieldEntries) =>
    findByType(['textarea'], entries) ||
    entries.find((entry) => entry.value.length > 24)

  const explicitName = String(payload.name || findField('name', 'full_name')).trim()
  const explicitPhone = String(payload.phone || findField('phone', 'phone_number', 'mobile', 'mobile_number')).trim()
  const explicitEmail = String(payload.email || findField('email')).trim()
  const remainingAfterExplicitCore = excludeValues(explicitName, explicitPhone, explicitEmail)

  const fallbackPhone =
    findByType(['tel'], remainingAfterExplicitCore)?.value ||
    findByValue((value) => isPhoneValue(value), remainingAfterExplicitCore)?.value ||
    ''
  const resolvedPhone = explicitPhone || fallbackPhone

  const remainingAfterPhone = excludeValues(explicitName, resolvedPhone, explicitEmail)
  const fallbackEmail =
    findByType(['email'], remainingAfterPhone)?.value ||
    findByValue((value) => isEmailValue(value), remainingAfterPhone)?.value ||
    ''
  const resolvedEmail = explicitEmail || fallbackEmail

  const remainingAfterCore = excludeValues(explicitName, resolvedPhone, resolvedEmail)
  const fallbackName = findLikelyName(remainingAfterCore)?.value || ''
  const resolvedName = explicitName || fallbackName

  const explicitCity = String(payload.city || findField('city', 'location')).trim()
  const explicitBudget = String(payload.budget || findField('budget')).trim()
  const explicitMessage = String(payload.message || findField('message', 'notes', 'requirements')).trim()

  const remainingAfterNamedFields = excludeValues(
    resolvedName,
    resolvedPhone,
    resolvedEmail,
    explicitCity,
    explicitBudget,
    explicitMessage
  )

  const fallbackCity = findLikelyCity(remainingAfterNamedFields)?.value || ''
  const resolvedCity = explicitCity || fallbackCity

  const remainingAfterCity = excludeValues(
    resolvedName,
    resolvedPhone,
    resolvedEmail,
    resolvedCity,
    explicitBudget,
    explicitMessage
  )
  const fallbackMessage = findLikelyMessage(remainingAfterCity)?.value || ''
  const resolvedMessage = explicitMessage || fallbackMessage

  // ─── Build rawFields: capture EVERY form field that has a value ───────────
  // This is stored on the lead so the CRM can display all submitted data
  // regardless of whether the field is a known CRM field or a custom one.
  const rawFields: Record<string, string> = {}

  // 1. All parsed form field entries (from payload.fields array or extra top-level keys)
  for (const entry of fieldEntries) {
    if (!entry.value) continue
    // Prefer human-readable label; fall back to the raw key
    const displayKey = (entry.label && entry.label !== entry.key.toLowerCase())
      ? entry.label
      : entry.key
    rawFields[displayKey] = entry.value
  }

  // 2. Known top-level fields that were excluded from topLevelFields by reservedTopLevelKeys
  //    but may not be present inside payload.fields
  if (resolvedName) rawFields['name'] = rawFields['name'] ?? resolvedName
  if (resolvedPhone) rawFields['phone'] = rawFields['phone'] ?? resolvedPhone
  if (resolvedEmail) rawFields['email'] = rawFields['email'] ?? resolvedEmail
  if (resolvedCity) rawFields['city'] = rawFields['city'] ?? resolvedCity
  if (explicitBudget) rawFields['budget'] = rawFields['budget'] ?? explicitBudget
  if (resolvedMessage) rawFields['message'] = rawFields['message'] ?? resolvedMessage

  // 3. UTM parameters
  const utmSourceVal = String(payload.utmSource || payload.utm_source || '').trim()
  const utmMediumVal = String(payload.utmMedium || payload.utm_medium || '').trim()
  const utmCampaignVal = String(payload.utmCampaign || payload.utm_campaign || '').trim()
  const utmTermVal = String(payload.utmTerm || payload.utm_term || '').trim()
  const utmContentVal = String(payload.utmContent || payload.utm_content || '').trim()
  if (utmSourceVal) rawFields['utm_source'] = utmSourceVal
  if (utmMediumVal) rawFields['utm_medium'] = utmMediumVal
  if (utmCampaignVal) rawFields['utm_campaign'] = utmCampaignVal
  if (utmTermVal) rawFields['utm_term'] = utmTermVal
  if (utmContentVal) rawFields['utm_content'] = utmContentVal

  // 4. Form / campaign name
  const formNameVal = String(payload.form?.name || payload.form_name || payload.formName || '').trim()
  if (formNameVal) rawFields['form_name'] = formNameVal
  const campaignTopLevel = String(payload.campaign || '').trim()
  if (campaignTopLevel) rawFields['campaign'] = rawFields['campaign'] ?? campaignTopLevel
  // ─────────────────────────────────────────────────────────────────────────

  return {
    name: resolvedName,
    phone: resolvedPhone,
    email: resolvedEmail || undefined,
    city: resolvedCity || undefined,
    campaign:
      String(payload.campaign || findField('campaign', 'campaign_name')).trim() ||
      String(payload.form?.name || payload.form_name || payload.formName || '').trim() ||
      undefined,
    budget: explicitBudget || undefined,
    message: resolvedMessage || undefined,
    utmSource: String(payload.utmSource || payload.utm_source || '').trim() || undefined,
    utmMedium: String(payload.utmMedium || payload.utm_medium || '').trim() || undefined,
    utmCampaign: String(payload.utmCampaign || payload.utm_campaign || '').trim() || undefined,
    rawFields: Object.keys(rawFields).length > 0 ? rawFields : undefined,
  }
}

export const handleExotelCallStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use the shared, full Exotel webhook processor so:
    // - missing call records are created
    // - matching leads are created/linked
    // - lead dispositions + call status are updated
    await processExotelCallStatus(req.body as ExotelCallStatusPayload)
    return res.status(200).send('OK')
  } catch (err) {
    next(err)
  }
}

export const handleExotelSmsStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await processExotelSmsStatus(req.body as ExotelSMSStatusCallbackPayload)
    return res.status(200).send('OK')
  } catch (err) {
    next(err)
  }
}

export const handleWebsiteLead = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configuredToken = process.env.WEBSITE_LEAD_WEBHOOK_TOKEN
    const providedToken = String(req.query.token || req.get('x-webhook-token') || req.body?.token || '').trim()

    if (configuredToken && providedToken !== configuredToken) {
      return res.status(401).json({ success: false, message: 'Invalid webhook token' })
    }

    const parsedPayload = parseWebsiteLeadPayload(req.body as Record<string, any>)
    const { name, phone } = parsedPayload

    if (!name || !phone) {
      logger.warn('Website lead rejected because required fields could not be resolved', {
        bodyKeys: Object.keys(req.body || {}),
        hasFieldsArray: Array.isArray(req.body?.fields),
        fieldsObjectKeys:
          req.body?.fields && typeof req.body.fields === 'object' && !Array.isArray(req.body.fields)
            ? Object.keys(req.body.fields)
            : [],
        parsedPayload,
      })
      return res.status(400).json({ success: false, message: 'name and phone are required' })
    }

    await processWebsiteLead(parsedPayload)
    return res.status(200).json({ success: true })
  } catch (err) {
    next(err)
  }
}

export const handleMetaLeadWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.get('x-hub-signature-256') || undefined
    const isValidSignature = verifyMetaWebhookSignature(req.rawBody, signature, process.env.META_APP_SECRET)

    if (!isValidSignature) {
      return res.status(401).json({ success: false, message: 'Invalid Meta webhook signature' })
    }

    const { object, entry } = req.body

    if (object !== 'page') {
      return res.status(200).send('EVENT_RECEIVED')
    }

    for (const pageEntry of entry || []) {
      for (const change of pageEntry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value?.leadgen_id
          const formId = change.value?.form_id

          if (leadgenId) {
            await processMetaLeadgen(leadgenId, formId)
            emitToTeam('all', 'meta:lead_received', { leadgenId, formId })
          }
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED')
  } catch (err) {
    next(err)
  }
}

export const verifyMetaWebhook = (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN

  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }

  return res.status(403).json({ success: false, message: 'Verification failed' })
}

export const handleWhatsAppWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { object, entry } = req.body

    if (object !== 'whatsapp_business_account') {
      return res.status(200).send('EVENT_RECEIVED')
    }

    for (const businessEntry of entry || []) {
      for (const change of businessEntry.changes || []) {
        const messages = change.value?.messages || []
        for (const message of messages) {
          if (message.type === 'text') {
            emitToTeam('all', 'whatsapp:message_received', {
              from: message.from,
              text: message.text?.body,
              messageId: message.id,
              timestamp: message.timestamp,
            })
          }
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED')
  } catch (err) {
    next(err)
  }
}

export const verifyWhatsAppWebhook = (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN

  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }

  return res.status(403).json({ success: false, message: 'Verification failed' })
}

export const handleExotelAnalyzeResult = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body as ExoVoiceAnalyzeWebhookPayload
    await processExoVoiceAnalyzeResult(payload)
    return res.status(200).json({ success: true })
  } catch (err) {
    next(err)
  }
}

// Legacy helper removed: outcomes/status updates are handled by `processExotelCallStatus`.
