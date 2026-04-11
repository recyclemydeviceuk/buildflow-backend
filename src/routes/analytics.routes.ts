import { Router } from 'express'
import {
  getRepresentativePerformanceDashboard,
  getRepresentativeDashboard,
  getManagerDashboard,
  getKPIs,
  getSourcePerformance,
  getUtmPerformance,
  getConversionFunnel,
  getRepPerformance,
} from '../controllers/analytics.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager } from '../middleware/role.middleware'
import { requireFeature } from '../middleware/featureControl.middleware'

const router = Router()

router.use(authenticate, requireFeature('analyticsAccess'))

router.get('/rep-dashboard', getRepresentativeDashboard)
router.get('/rep-performance-dashboard', getRepresentativePerformanceDashboard)

router.use(requireManager)

router.get('/manager-dashboard', getManagerDashboard)
router.get('/kpis', getKPIs)
router.get('/source-performance', getSourcePerformance)
router.get('/utm-performance', getUtmPerformance)
router.get('/conversion-funnel', getConversionFunnel)
router.get('/rep-performance', getRepPerformance)

export default router
