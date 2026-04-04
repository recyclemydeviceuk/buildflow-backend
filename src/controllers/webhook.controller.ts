import { Request, Response, NextFunction } from 'express'
import { emitToTeam } from '../config/socket'
import { processExotelCallStatus } from '../webhooks/exotel.webhook'
import { processExoVoiceAnalyzeResult } from '../webhooks/exotelAnalyze.webhook'
import { processExotelSmsStatus } from '../webhooks/exotelSms.webhook'
import { processMetaLeadgen } from '../webhooks/meta.webhook'
import { processWebsiteLead } from '../webhooks/website.webhook'
import { ExotelCallStatusPayload, ExotelSMSStatusCallbackPayload, ExoVoiceAnalyzeWebhookPayload } from '../types/exotel.types'

const parseWebsiteLeadPayload = (payload: Record<string, any>) => {
  const fields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : {}
  const fieldEntries = Object.entries(fields).map(([key, value]) => {
    if (value && typeof value === 'object') {
      return {
        key,
        label: String((value as any).title || (value as any).label || key).toLowerCase(),
        value: String((value as any).value || (value as any).raw_value || '').trim(),
      }
    }

    return {
      key,
      label: String(key).toLowerCase(),
      value: String(value || '').trim(),
    }
  })

  const findField = (...names: string[]) => {
    const normalizedNames = names.map((name) => name.toLowerCase())
    const exact = fieldEntries.find((entry) => normalizedNames.includes(entry.key.toLowerCase()) || normalizedNames.includes(entry.label))
    if (exact?.value) return exact.value

    const partial = fieldEntries.find((entry) =>
      normalizedNames.some((name) => entry.key.toLowerCase().includes(name) || entry.label.includes(name))
    )
    return partial?.value || ''
  }

  return {
    name: String(payload.name || findField('name', 'full_name')).trim(),
    phone: String(payload.phone || findField('phone', 'phone_number', 'mobile', 'mobile_number')).trim(),
    email: String(payload.email || findField('email')).trim() || undefined,
    city: String(payload.city || findField('city', 'location')).trim() || undefined,
    campaign:
      String(payload.campaign || findField('campaign', 'campaign_name')).trim() ||
      String(payload.form_name || payload.formName || '').trim() ||
      undefined,
    budget: String(payload.budget || findField('budget')).trim() || undefined,
    message: String(payload.message || findField('message', 'notes', 'requirements')).trim() || undefined,
    utmSource: String(payload.utmSource || payload.utm_source || '').trim() || undefined,
    utmMedium: String(payload.utmMedium || payload.utm_medium || '').trim() || undefined,
    utmCampaign: String(payload.utmCampaign || payload.utm_campaign || '').trim() || undefined,
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
    const parsedPayload = parseWebsiteLeadPayload(req.body as Record<string, any>)
    const { name, phone } = parsedPayload

    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'name and phone are required' })
    }

    await processWebsiteLead(parsedPayload)
    return res.status(201).json({ success: true })
  } catch (err) {
    next(err)
  }
}

export const handleMetaLeadWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
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
