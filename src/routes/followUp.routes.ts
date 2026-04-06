import { Router } from 'express'
import { param } from 'express-validator'
import {
  confirmFollowUpPopup,
  getFollowUps,
  getNextFollowUpPopup,
  skipFollowUpPopup,
} from '../controllers/followUp.controller'
import { authenticate } from '../middleware/auth.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate)

router.get('/', getFollowUps)
router.get('/notifications/next', getNextFollowUpPopup)
router.patch('/:id/notifications/confirm', [param('id').isMongoId()], validate, confirmFollowUpPopup)
router.patch('/:id/notifications/skip', [param('id').isMongoId()], validate, skipFollowUpPopup)

export default router
