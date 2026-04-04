import { Router } from 'express'
import { param } from 'express-validator'
import {
  getAuditLogs,
  getAuditLogFilters,
  getAuditLogById,
  getAuditLogsByEntity,
} from '../controllers/auditLog.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate, requireManager)

router.get('/', getAuditLogs)
router.get('/filters', getAuditLogFilters)

router.get('/:id', [param('id').isMongoId()], validate, getAuditLogById)

router.get('/:entity/:entityId', getAuditLogsByEntity)

export default router
