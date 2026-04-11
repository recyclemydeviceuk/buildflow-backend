import { Router } from 'express'
import { body, param } from 'express-validator'
import {
  initiateCall,
  getCalls,
  getCallById,
  getCallsByLead,
  postCallFeedback,
  syncCallFromExotel,
  syncCallsFromExotel,
  getCallRecording,
  getCallsDebug,
  purgeOrphanedCalls,
} from '../controllers/call.controller'
import { listMessagesForCall, sendMessageForCall } from '../controllers/sms.controller'
import { authenticate } from '../middleware/auth.middleware'
import { validate } from '../middleware/validate.middleware'
import { requireFeature } from '../middleware/featureControl.middleware'

const router = Router()

router.use(authenticate)

router.get('/', getCalls)

router.get('/debug', getCallsDebug)

router.post('/purge-orphaned', purgeOrphanedCalls)

router.post('/sync', syncCallsFromExotel)

router.get('/:id/recording', getCallRecording)

router.get('/:id/messages', [param('id').isMongoId()], validate, listMessagesForCall)

router.post(
  '/:id/messages',
  [
    param('id').isMongoId(),
    body('body').isString().trim().notEmpty().isLength({ max: 640 }),
  ],
  validate,
  sendMessageForCall
)

router.get('/:id', [param('id').isMongoId()], validate, getCallById)

router.get('/lead/:leadId', [param('leadId').isMongoId()], validate, getCallsByLead)

router.post(
  '/initiate',
  requireFeature('dialer'),
  [
    body('leadId').optional().isMongoId(),
    body('phone').optional().isString().notEmpty(),
    body('leadName').optional().isString(),
    body('city').optional().isString(),
    body('agentPhone').optional().isString().notEmpty(),
    body('representativeId').optional().isMongoId(),
    body('recordCall').optional().isBoolean(),
  ],
  validate,
  initiateCall
)

router.patch(
  '/:id/feedback',
  [param('id').isMongoId()],
  validate,
  postCallFeedback
)

router.post(
  '/:callSid/sync',
  [param('callSid').notEmpty()],
  validate,
  syncCallFromExotel
)

export default router
