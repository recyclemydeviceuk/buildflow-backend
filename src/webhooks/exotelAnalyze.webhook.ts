import { Call } from '../models/Call'
import { emitToTeam } from '../config/socket'
import { ExoVoiceAnalyzeWebhookPayload } from '../types/exotel.types'
import { logger } from '../utils/logger'

export const processExoVoiceAnalyzeResult = async (
  payload: ExoVoiceAnalyzeWebhookPayload
): Promise<void> => {
  try {
    const { success, callSID, job_id, summary, sentiment, category, transcript } = payload

    const call = await Call.findOne({ exotelCallSid: callSID })
    if (!call) {
      logger.warn('ExoVoiceAnalyze webhook: call not found', { callSID, job_id })
      return
    }

    if (!success) {
      call.aiAnalysisStatus = 'failed'
      await call.save()
      logger.warn('ExoVoiceAnalyze failed', { callSID, reason: payload.reason })
      return
    }

    call.aiAnalysisStatus = 'completed'

    if (transcript) {
      call.transcript = transcript
    }

    if (summary) {
      call.summary = summary.summary
    }

    if (sentiment) {
      call.sentiment = sentiment.sentiment
      call.sentimentConfidence = sentiment.confidence
    }

    if (category) {
      call.aiCategory = category.category
      call.aiCategoryConfidence = category.confidence
    }

    await call.save()

    logger.info('ExoVoiceAnalyze result stored', {
      callSID,
      job_id,
      sentiment: sentiment?.sentiment,
      hasTranscript: !!transcript,
    })

    emitToTeam('all', 'call:analysis_ready', {
      callId: call._id,
      callSid: callSID,
      sentiment: call.sentiment,
      summary: call.summary,
      aiCategory: call.aiCategory,
    })
  } catch (err) {
    logger.error('processExoVoiceAnalyzeResult error', err)
  }
}
