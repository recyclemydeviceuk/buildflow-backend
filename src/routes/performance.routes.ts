import { Router } from 'express'
import { param } from 'express-validator'
import {
  getRepresentativesPerformance,
  getRepresentativeDetailPerformance,
} from '../controllers/performance.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate, requireManager)

// Get all representatives performance summary
router.get('/representatives', getRepresentativesPerformance)

// Get detailed performance for a specific representative
router.get(
  '/representatives/:id',
  [param('id').isMongoId()],
  validate,
  getRepresentativeDetailPerformance
)

export default router
