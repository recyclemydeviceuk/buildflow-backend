import { Router } from 'express'
import {
  getAppConfig,
  getSettings,
  updateLeadRouting,
  updateCityAssignmentRules,
  updateLeadFields,
  updateCities,
  updateSources,
  updateFeatureControls,
  updateNotificationSettings,
  getSmsTemplates,
  updateSmsTemplates,
  getTeamMembers,
  createTeamMember,
  updateTeamMember,
  resetMemberPassword,
  deactivateTeamMember,
  activateTeamMember,
  deleteTeamMember,
  updateMyProfile,
} from '../controllers/settings.controller'
import { getMe } from '../controllers/auth.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'
import { param } from 'express-validator'
import {
  createTeamMemberValidators,
  resetMemberPasswordValidators,
  updateProfileValidators,
  updateTeamMemberValidators,
} from '../validators/settings.validator'

const router = Router()

router.use(authenticate)

router.get('/me', getMe)
router.patch('/me', updateProfileValidators, validate, updateMyProfile)
router.get('/sms-templates', getSmsTemplates)
router.put('/sms-templates', updateSmsTemplates)
router.get('/app-config', getAppConfig)

router.get('/', requireManager, getSettings)
router.patch('/lead-routing', requireManager, updateLeadRouting)
router.patch('/city-assignment-rules', requireManager, updateCityAssignmentRules)
router.patch('/lead-fields', requireManager, updateLeadFields)
router.patch('/cities', requireManager, updateCities)
router.patch('/sources', requireManager, updateSources)
router.patch('/feature-controls', requireManager, updateFeatureControls)
router.patch('/notifications', requireManager, updateNotificationSettings)

router.get('/team', getTeamMembers)

router.post(
  '/team',
  requireManager,
  createTeamMemberValidators,
  validate,
  createTeamMember
)

router.patch('/team/:id', requireManager, updateTeamMemberValidators, validate, updateTeamMember)

router.patch('/team/:id/password', requireManager, resetMemberPasswordValidators, validate, resetMemberPassword)

router.patch('/team/:id/deactivate', requireManager, [param('id').isMongoId()], validate, deactivateTeamMember)

router.patch('/team/:id/activate', requireManager, [param('id').isMongoId()], validate, activateTeamMember)

router.delete('/team/:id', requireManager, [param('id').isMongoId()], validate, deleteTeamMember)

export default router
