import { Call } from '../models/Call'
import { getCallDetails } from '../services/exotel.service'
import {
  closeStaleOpenCall,
  normalizeStatus,
  reconcileRepresentativeAvailabilityStates,
  refreshCallFromExotel,
  syncExotelCallHistory,
  syncRecentExotelCallHistory,
} from '../services/callSync.service'
import { OPEN_CALL_STATUSES } from '../utils/callState'
import { parseExotelDate } from '../utils/exotelDate'
import { logger } from '../utils/logger'

let intervalId: NodeJS.Timeout | null = null

const resolveStaleCall = async (call: any) => {
  if (!call.exotelCallSid) return

  // Outbound calls are placed through Exotel v3, which is the authoritative
  // source for their state, so ask it first.
  const refreshed = await refreshCallFromExotel(call, { emitEvents: true })
  if (refreshed !== 'unavailable') return

  const directSync = await syncExotelCallHistory({
    emitEvents: true,
    maxPages: 1,
    pageSize: 10,
    sids: [call.exotelCallSid],
  })

  if (directSync.fetchedCount > 0) {
    logger.info('Stale call synced from Exotel history', {
      callSid: call.exotelCallSid,
      createdCount: directSync.createdCount,
      updatedCount: directSync.updatedCount,
      unchangedCount: directSync.unchangedCount,
    })
  } else {
    const details = await getCallDetails(call.exotelCallSid)
    if (details) {
      if (details.Status) call.status = normalizeStatus(details.Status)
      if (details.Duration) call.duration = parseInt(details.Duration, 10)
      if (details.RecordingUrl) call.recordingUrl = details.RecordingUrl
      if (details.StartTime) call.startedAt = parseExotelDate(details.StartTime) ?? call.startedAt
      if (details.EndTime) call.endedAt = parseExotelDate(details.EndTime) ?? call.endedAt

      if (['completed', 'failed', 'no-answer', 'busy', 'canceled'].includes(call.status) && !call.outcome) {
        call.outcome = call.status === 'completed' ? 'Connected' : 'Not Answered'
      }

      await call.save()
      logger.info('Call fallback synced from Exotel details', { callSid: call.exotelCallSid, status: call.status })
    }
  }

  const latest = await Call.findById(call._id)
  if (latest) {
    await closeStaleOpenCall(latest, { emitEvents: true })
  }
}

const runCallSync = async () => {
  try {
    // A failure in the bulk history sync must not stop open calls below from
    // being resolved, or reps stay locked on "Dialing".
    try {
      const historySync = await syncRecentExotelCallHistory()
      if (historySync.fetchedCount > 0) {
        logger.info('Exotel history sync completed', historySync)
      }
    } catch (err) {
      logger.error('callSyncPoller history sync error', err)
    }

    const staleCalls = await Call.find({
      status: { $in: OPEN_CALL_STATUSES },
      startedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) },
      exotelCallSid: { $ne: null },
    })

    for (const call of staleCalls) {
      // One bad record must not stop the rest from being resolved.
      try {
        await resolveStaleCall(call)
      } catch (err) {
        logger.error('callSyncPoller failed to resolve open call', { callSid: call.exotelCallSid, err })
      }
    }

    const reconciliation = await reconcileRepresentativeAvailabilityStates()
    if (reconciliation.repairedCount > 0) {
      logger.info('Representative call availability reconciled', reconciliation)
    }
  } catch (err) {
    logger.error('callSyncPoller job error', err)
  }
}

export const startCallSyncPoller = () => {
  if (intervalId) return
  runCallSync().catch((err) => logger.error('Initial callSyncPoller run error', err))
  intervalId = setInterval(runCallSync, 2 * 60 * 1000)
  logger.info('callSyncPoller job started (every 2m)')
}

export const stopCallSyncPoller = () => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('callSyncPoller job stopped')
  }
}
