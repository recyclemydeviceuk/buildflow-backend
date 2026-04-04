import { QueueItem } from '../models/QueueItem'
import { Settings } from '../models/Settings'
import { autoRouteQueueItem } from '../services/leadRouting.service'
import { expireOffer } from '../services/queue.service'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'

let intervalId: NodeJS.Timeout | null = null

const runEscalationCheck = async () => {
  try {
    const settings = await Settings.findOne()
    const skipLimit = settings?.leadRouting?.skipLimit || 3
    const autoEscalate = settings?.leadRouting?.autoEscalate ?? true

    const expiredOffers = await QueueItem.find({
      status: 'offered',
      offerExpiresAt: { $lt: new Date() },
    })

    for (const item of expiredOffers) {
      logger.info('Expiring offer', { queueItemId: item._id })
      await expireOffer(String(item._id))
    }

    if (autoEscalate) {
      const escalatable = await QueueItem.find({
        status: 'waiting',
        skipCount: { $gte: skipLimit },
        segment: { $ne: 'Escalated' },
      })

      for (const item of escalatable) {
        item.segment = 'Escalated'
        await item.save()
        emitToTeam('all', 'queue:lead_escalated', { queueItemId: item._id, leadId: item.leadId })
        logger.info('Lead escalated', { queueItemId: item._id })
      }
    }

    const unrouted = await QueueItem.find({
      status: 'waiting',
      segment: 'Unassigned',
      offeredTo: null,
    }).sort({ urgency: -1, createdAt: 1 }).limit(5)

    for (const item of unrouted) {
      await autoRouteQueueItem(String(item._id))
    }
  } catch (err) {
    logger.error('queueEscalation job error', err)
  }
}

export const startQueueEscalation = () => {
  if (intervalId) return
  intervalId = setInterval(runEscalationCheck, 30 * 1000)
  logger.info('queueEscalation job started (every 30s)')
  runEscalationCheck()
}

export const stopQueueEscalation = () => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('queueEscalation job stopped')
  }
}
