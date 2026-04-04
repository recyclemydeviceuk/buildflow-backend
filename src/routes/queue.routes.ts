import { Router } from 'express'
import { param, body } from 'express-validator'
import {
  getQueue,
  getLiveQueue,
  assignQueueItem,
  requeueItem,
  holdQueueItem,
  markInvalid,
  skipQueueItem,
} from '../controllers/queue.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate)

router.get('/', getQueue)

router.get('/live', getLiveQueue)

router.patch('/:id/assign', requireManager, [param('id').isMongoId(), body('userId').isMongoId()], validate, assignQueueItem)

router.patch('/:id/requeue', requireManager, [param('id').isMongoId()], validate, requeueItem)

router.patch('/:id/hold', [param('id').isMongoId(), body('holdUntil').isISO8601()], validate, holdQueueItem)

router.patch('/:id/invalid', requireManager, [param('id').isMongoId()], validate, markInvalid)

router.patch('/:id/skip', [param('id').isMongoId()], validate, skipQueueItem)

export default router
