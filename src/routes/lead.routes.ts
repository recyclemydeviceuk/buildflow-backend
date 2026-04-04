import { Router } from 'express'
import { body, param, query } from 'express-validator'
import {
  getLeads,
  getLeadById,
  createLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  assignLead,
  updateDisposition,
  getLeadFilters,
  lookupLeadsByPhones,
  addStatusNote,
  updateStatusNote,
  deleteStatusNote,
  previewLeadImport,
  importLeadsFromFile,
  exportLeads,
  getLeadFollowUps,
  createFollowUp,
  updateFollowUp,
  deleteFollowUp,
} from '../controllers/lead.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager, requireRole } from '../middleware/role.middleware'
import { uploadImport } from '../middleware/multer.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate)

router.post('/import/preview', requireRole('manager', 'representative'), uploadImport, previewLeadImport)
router.post('/import', requireRole('manager', 'representative'), uploadImport, importLeadsFromFile)
router.post('/export', requireRole('manager', 'representative'), exportLeads)
router.post('/bulk-delete', requireRole('manager', 'representative'), [body('ids').isArray({ min: 1 }), body('ids.*').isMongoId()], validate, bulkDeleteLeads)
router.get('/filters', getLeadFilters)
router.post('/lookup-by-phone', [body('phones').isArray()], validate, lookupLeadsByPhones)

router.get('/', getLeads)

router.get('/:id', [param('id').isMongoId()], validate, getLeadById)

router.post(
  '/',
  requireRole('manager', 'representative'),
  [
    body('name').notEmpty().trim(),
    body('phone').notEmpty().trim(),
    body('city').notEmpty().trim(),
  ],
  validate,
  createLead
)

router.put('/:id', [param('id').isMongoId()], validate, updateLead)

router.delete('/:id', requireRole('manager', 'representative'), [param('id').isMongoId()], validate, deleteLead)

router.patch(
  '/:id/assign',
  requireManager,
  [param('id').isMongoId(), body('userId').optional({ nullable: true }).isMongoId()],
  validate,
  assignLead
)

router.patch(
  '/:id/disposition',
  [param('id').isMongoId(), body('disposition').notEmpty()],
  validate,
  updateDisposition
)

router.patch(
  '/:id/status-notes',
  [param('id').isMongoId(), body('status').notEmpty(), body('note').notEmpty().trim()],
  validate,
  addStatusNote
)

router.patch(
  '/:id/status-notes/:noteId',
  [param('id').isMongoId(), param('noteId').isMongoId(), body('status').notEmpty(), body('note').notEmpty().trim()],
  validate,
  updateStatusNote
)

router.delete(
  '/:id/status-notes/:noteId',
  [param('id').isMongoId(), param('noteId').isMongoId()],
  validate,
  deleteStatusNote
)

// Follow-up routes
router.get('/:id/follow-ups', [param('id').isMongoId()], validate, getLeadFollowUps)
router.post('/:id/follow-ups', [param('id').isMongoId(), body('scheduledAt').notEmpty()], validate, createFollowUp)
router.patch('/:id/follow-ups/:followUpId', [param('id').isMongoId(), param('followUpId').isMongoId()], validate, updateFollowUp)
router.delete('/:id/follow-ups/:followUpId', [param('id').isMongoId(), param('followUpId').isMongoId()], validate, deleteFollowUp)

export default router
