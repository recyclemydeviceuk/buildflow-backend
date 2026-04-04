import { Router } from 'express'
import {
  getLeadPipelineReport,
  getCallActivityReport,
  exportLeadsCSV,
  exportCallsCSV,
} from '../controllers/reports.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'

const router = Router()

router.use(authenticate, requireManager)

router.get('/lead-pipeline', getLeadPipelineReport)
router.get('/call-activity', getCallActivityReport)
router.get('/export/leads', exportLeadsCSV)
router.get('/export/calls', exportCallsCSV)

export default router
