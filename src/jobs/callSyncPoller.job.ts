import { Call } from '../models/Call'
import { getCallDetails } from '../services/exotel.service'
import { reconcileRepresentativeAvailabilityStates, syncExotelCallHistory, syncRecentExotelCallHistory } from '../services/callSync.service'
import { parseExotelDate } from '../utils/exotelDate'
import { logger } from '../utils/logger'

let intervalId: NodeJS.Timeout | null = null

const runCallSync = async () => {
  try {
    const historySync = await syncRecentExotelCallHistory()
    if (historySync.fetchedCount > 0) {
      logger.info('Exotel history sync completed', historySync)
    }

    const staleCalls = await Call.find({
      status: { $in: ['initiated', 'ringing', 'in-progress'] },
      startedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) },
      exotelCallSid: { $ne: null },
    })

    for (const call of staleCalls) {
      if (!call.exotelCallSid) continue

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
        continue
      }

      const details = await getCallDetails(call.exotelCallSid)
      if (!details) continue

      if (details.Status) call.status = details.Status.toLowerCase()
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
