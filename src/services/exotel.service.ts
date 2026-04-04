import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { exotelConfig } from '../config/exotel'
import {
  ExotelOutboundCallParams,
  ExotelCallResponse,
  ExotelBulkCallListResponse,
  ExotelV3CreateCallParams,
  ExotelV3CreateCallResponse,
  ExotelV3CallDetails,
  ExotelSMSResponse,
  ExotelSMSParams,
} from '../types/exotel.types'
import { APP_BASE_URL } from '../config/constants'
import { logger } from '../utils/logger'

export class ExotelManagedCallError extends Error {
  httpCode?: number
  exotelCode?: number

  constructor(message: string, options?: { httpCode?: number; exotelCode?: number }) {
    super(message)
    this.name = 'ExotelManagedCallError'
    this.httpCode = options?.httpCode
    this.exotelCode = options?.exotelCode
  }
}

export const initiateOutboundCall = async (
  toNumber: string,
  customerId: string
): Promise<ExotelCallResponse['Call'] | null> => {
  try {
    const params: ExotelOutboundCallParams = {
      // Outbound call bridge: `From` should be the customer's/agent dialed number,
      // and `To` should be the destination number.
      // `call.controller` is the primary entrypoint for connect; this function is a fallback.
      From: exotelConfig.exoPhone,
      To: toNumber,
      CallerId: exotelConfig.exoPhone,
      StatusCallback: exotelConfig.statusCallbackUrl,
      StatusCallbackContentType: 'application/json',
      StatusCallbackEvents: ['terminal'],
      Record: exotelConfig.recordingEnabled ? 'true' : 'false',
      RecordingChannels: exotelConfig.recordingChannels,
      TimeLimit: 3600,
      TimeOut: 40,
    }

    const response = await axios.post<ExotelCallResponse>(
      `${exotelConfig.baseUrl}/Calls/connect.json`,
      new URLSearchParams(params as unknown as Record<string, string>).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    return response.data.Call
  } catch (err) {
    logger.error('Exotel initiateOutboundCall error', err)
    return null
  }
}

export const getCallDetails = async (callSid: string): Promise<ExotelCallResponse['Call'] | null> => {
  try {
    const response = await axios.get<ExotelCallResponse>(
      `${exotelConfig.baseUrl}/Calls/${callSid}.json`
    )
    return response.data.Call
  } catch (err) {
    logger.error('Exotel getCallDetails error', err)
    return null
  }
}

const normalizeBulkCallResponse = (data: any): ExotelBulkCallListResponse => {
  const payload = data?.RestResponse || data?.TwilioResponse || data || {}

  return {
    Metadata: payload.Metadata || undefined,
    Calls: Array.isArray(payload.Calls) ? payload.Calls : [],
  }
}

export const listCalls = async (
  params: Record<string, string | number | undefined>
): Promise<ExotelBulkCallListResponse | null> => {
  try {
    const filteredParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
    )

    const response = await axios.get(`${exotelConfig.baseUrl}/Calls.json`, {
      params: filteredParams,
      paramsSerializer: {
        serialize: (queryParams) => new URLSearchParams(queryParams as Record<string, string>).toString(),
      },
    })

    return normalizeBulkCallResponse(response.data)
  } catch (err) {
    logger.error('Exotel listCalls error', { err, params })
    return null
  }
}

export const initiateManagedCall = async (
  params: ExotelV3CreateCallParams
): Promise<ExotelV3CreateCallResponse['response']['call_details']> => {
  try {
    const response = await axios.post<ExotelV3CreateCallResponse>(
      `${exotelConfig.voiceV3BaseUrl}/calls`,
      params,
      { headers: { 'Content-Type': 'application/json' } }
    )

    const callDetails = response.data?.response?.call_details
    if (!callDetails?.sid) {
      throw new ExotelManagedCallError('Exotel did not return a call SID', {
        httpCode: response.data?.http_code,
      })
    }

    return callDetails
  } catch (err: any) {
    const errorData = err?.response?.data?.response?.error_data
    const message =
      errorData?.description ||
      errorData?.message ||
      err?.response?.data?.message ||
      'Failed to initiate Exotel managed call'

    logger.error('Exotel initiateManagedCall error', {
      message,
      errorData,
      status: err?.response?.status,
    })

    throw new ExotelManagedCallError(message, {
      httpCode: err?.response?.status,
      exotelCode: errorData?.code,
    })
  }
}

export const getManagedCallDetails = async (
  callSid: string
): Promise<ExotelV3CallDetails | null> => {
  try {
    const response = await axios.get<ExotelV3CreateCallResponse>(
      `${exotelConfig.voiceV3BaseUrl}/calls/${callSid}`,
      { headers: { 'Content-Type': 'application/json' } }
    )

    return response.data?.response?.call_details || null
  } catch (err) {
    logger.error('Exotel getManagedCallDetails error', { callSid, err })
    return null
  }
}

export const sendSMS = async (params: {
  to: string
  body: string
  from?: string
  statusCallback?: string
  customField?: string
}): Promise<{
  success: boolean
  sid?: string | null
  status?: string | null
  detailedStatus?: string | null
  detailedStatusCode?: string | null
}> => {
  const buildFromCandidates = (value?: string): string[] => {
    if (!value) return []

    const trimmed = value.trim()
    if (!trimmed) return []

    const digits = trimmed.replace(/\D/g, '')
    const candidates = new Set<string>()
    candidates.add(trimmed)

    if (digits) {
      candidates.add(digits)
      if (digits.length === 12 && digits.startsWith('91')) {
        candidates.add(digits.slice(2))
      }
      if (digits.length === 11 && digits.startsWith('0')) {
        candidates.add(digits.slice(1))
      }
      if (digits.length === 10) {
        candidates.add(digits)
      }
    }

    return Array.from(candidates).filter(Boolean)
  }

  const fromCandidates = buildFromCandidates(params.from || exotelConfig.smsFrom || exotelConfig.exoPhone)
  const toCandidates = Array.from(
    new Set([
      params.to,
      params.to?.startsWith('+91') ? params.to.slice(3) : undefined,
    ].filter(Boolean) as string[])
  )

  let lastError: any = null

  try {
    for (const fromCandidate of fromCandidates.length ? fromCandidates : ['']) {
      for (const toCandidate of toCandidates.length ? toCandidates : [params.to]) {
        const payload: ExotelSMSParams = {
          From: fromCandidate,
          To: toCandidate,
          Body: params.body,
          StatusCallback: params.statusCallback,
          CustomField: params.customField,
          DltEntityId: exotelConfig.smsDltEntityId || undefined,
          DltTemplateId: exotelConfig.smsDltTemplateId || undefined,
          SmsType: exotelConfig.smsType,
          Priority: 'normal',
        }

        try {
          const response = await axios.post<ExotelSMSResponse>(
            `${exotelConfig.baseUrl}/Sms/send.json`,
            new URLSearchParams(
              Object.entries(payload).reduce<Record<string, string>>((acc, [key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                  acc[key] = String(value)
                }
                return acc
              }, {})
            ).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          )

          const smsMessage = response.data?.SMSMessage || response.data?.SmsMessage || {}
          return {
            success: true,
            sid: smsMessage.Sid || null,
            status: smsMessage.Status || 'submitted',
            detailedStatus: smsMessage.DetailedStatus || null,
            detailedStatusCode: smsMessage.DetailedStatusCode || null,
          }
        } catch (err) {
          lastError = err
        }
      }
    }

    throw lastError || new Error('Failed to send SMS')
  } catch (err) {
    logger.error('Exotel sendSMS error', err)
    const providerMessage =
      (err as any)?.response?.data?.SMSMessage?.DetailedStatus ||
      (err as any)?.response?.data?.SmsMessage?.DetailedStatus ||
      (err as any)?.response?.data?.message ||
      (err as any)?.message ||
      'Failed to send SMS'

    return {
      success: false,
      status: 'failed',
      detailedStatus: providerMessage.includes('400')
        ? `${providerMessage}. Check that this ExoPhone or sender ID is SMS-enabled in Exotel and that any DLT/template requirements are configured.`
        : providerMessage,
      detailedStatusCode:
        (err as any)?.response?.data?.SMSMessage?.DetailedStatusCode ||
        (err as any)?.response?.data?.SmsMessage?.DetailedStatusCode ||
        null,
    }
  }
}

export const triggerExoVoiceAnalyze = async (
  callSid: string,
  callDbId: string
): Promise<string | null> => {
  try {
    const taskId = `bf_${callDbId}_${uuidv4().slice(0, 8)}`
    const callbackUrl = `${APP_BASE_URL}/webhooks/exotel/analyze`

    const response = await axios.post<{
      ExoVoiceAnalyze: { job_id: string; task_id: string; call_sid: string; status: string }
      success: boolean
      reason?: string
      request_id?: string
    }>(
      `${exotelConfig.baseUrl}/Calls/${callSid}/ExoVoiceAnalyze.json`,
      {
        callback_url: callbackUrl,
        task_id: taskId,
        insight_tasks: ['transcript', 'summarization', 'sentiment', 'categorise'],
        categories: exotelConfig.analysisCategories,
      },
      { headers: { 'Content-Type': 'application/json' } }
    )

    if (response.data?.success) {
      logger.info('ExoVoiceAnalyze triggered', { callSid, jobId: response.data.ExoVoiceAnalyze.job_id })
      return response.data.ExoVoiceAnalyze.job_id
    }
    return null
  } catch (err) {
    logger.error('triggerExoVoiceAnalyze error', { callSid, err })
    return null
  }
}
