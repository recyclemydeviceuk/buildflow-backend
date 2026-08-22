import { Router } from 'express'
import { param } from 'express-validator'
import {
  getAuditLogs,
  getAuditLogFilters,
  getAuditLogById,
  getAuditLogsByEntity,
  getLeadTransferHistory,
} from '../controllers/auditLog.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { validate } from '../middleware/validate.middleware'
import { requireFeature } from '../middleware/featureControl.middleware'

const router = Router()

router.use(authenticate, requireManager, requireFeature('auditLog'))

router.get('/', getAuditLogs)
router.get('/filters', getAuditLogFilters)
router.get('/transfer-history', getLeadTransferHistory)
router.get('/transfers', getLeadTransferHistory)

// Constrain the dynamic route at the router level so a named endpoint can
// never be mistaken for an audit-log ID, regardless of future route ordering.
router.get('/:id([0-9a-fA-F]{24})', [param('id').isMongoId()], validate, getAuditLogById)

router.get('/:entity/:entityId', getAuditLogsByEntity)

export default router
