import { Router } from 'express'
import { param } from 'express-validator'
import {
  getIntegrations,
  getIntegrationById,
  disconnectIntegration,
  getGoogleAdsOAuthUrl,
  handleGoogleAdsOAuthCallback,
  getLinkedInOAuthUrl,
  handleLinkedInOAuthCallback,
  getGoogleAdsLeadForms,
  fetchGoogleAdsLeadsToCRM,
  getLinkedInLeadForms,
  fetchLinkedInLeadsToCRM,
  getExotelNumbers,
} from '../controllers/integration.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate, requireManager)

router.get('/', getIntegrations)
router.get('/:id', [param('id').isMongoId()], validate, getIntegrationById)
router.delete('/:id', [param('id').isMongoId()], validate, disconnectIntegration)

router.get('/google-ads/connect', getGoogleAdsOAuthUrl)
router.get('/google-ads/callback', handleGoogleAdsOAuthCallback)
router.get('/google-ads/forms', getGoogleAdsLeadForms)
router.post('/google-ads/fetch-leads', fetchGoogleAdsLeadsToCRM)

router.get('/linkedin/connect', getLinkedInOAuthUrl)
router.get('/linkedin/callback', handleLinkedInOAuthCallback)
router.get('/linkedin/forms', getLinkedInLeadForms)
router.post('/linkedin/fetch-leads', fetchLinkedInLeadsToCRM)

router.get('/exotel/numbers', getExotelNumbers)

export default router
