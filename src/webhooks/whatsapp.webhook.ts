import { WhatsAppMessagePayload } from '../types/webhook.types'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'

export const processWhatsAppMessage = async (payload: WhatsAppMessagePayload): Promise<void> => {
  try {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || []
        for (const message of messages) {
          if (message.type === 'text') {
            emitToTeam('all', 'whatsapp:message_received', {
              from: message.from,
              text: message.text?.body,
              messageId: message.id,
              timestamp: message.timestamp,
            })
            logger.info('WhatsApp message received', { from: message.from })
          }
        }
      }
    }
  } catch (err) {
    logger.error('processWhatsAppMessage error', err)
  }
}

export const verifyWhatsAppToken = (mode: string, token: string, challenge: string): string | null => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return challenge
  return null
}
