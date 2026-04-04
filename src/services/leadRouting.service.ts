import { logger } from '../utils/logger'

export const getNextRep = async (): Promise<{ id: string; name: string } | null> => {
  logger.info('getNextRep called while manual assignment mode is active')
  return null
}

export const autoRouteQueueItem = async (_queueItemId: string): Promise<boolean> => {
  logger.info('autoRouteQueueItem skipped because BuildFlow uses manager-led manual assignment')
  return false
}
