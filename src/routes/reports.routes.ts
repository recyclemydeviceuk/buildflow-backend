import { Router } from 'express'
import {
  getLeadPipelineReport,
  getCallActivityReport,
  exportLeadsCSV,
  exportCallsCSV,
} from '../controllers/reports.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { requireFeature } from '../middleware/featureControl.middleware'

const router = Router()

router.use(authenticate, requireManager)

router.get('/lead-pipeline', requireFeature('analyticsAccess'), getLeadPipelineReport)
router.get('/call-activity', requireFeature('analyticsAccess'), getCallActivityReport)
router.get('/export/leads', requireFeature('exportLeads'), exportLeadsCSV)
router.get('/export/calls', requireFeature('exportLeads'), exportCallsCSV)

export default router
