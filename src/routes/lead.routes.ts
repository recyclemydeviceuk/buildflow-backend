import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { body, param, query } from 'express-validator'
import {
  getLeads,
  getLeadById,
  createLead,
  updateLead,
  deleteLead,
  bulkUpdateLeads,
  bulkDeleteLeads,
  assignLead,
  updateDisposition,
  getLeadFilters,
  getFollowUpCounts,
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
  getPendingAssignments,
  respondToAssignment,
} from '../controllers/lead.controller'
import {
  getLeadFiles,
  uploadLeadFile,
  getLeadFileDownloadUrl,
  deleteLeadFile,
} from '../controllers/leadFile.controller'
import { authenticate } from '../middleware/auth.middleware'
import { requireManager, requireRole } from '../middleware/role.middleware'
import { uploadImport, uploadMedia } from '../middleware/multer.middleware'
import { validate } from '../middleware/validate.middleware'
import { requireFeature, requireDeletePermission } from '../middleware/featureControl.middleware'
import { MEDIA_MAX_FILE_SIZE_MB } from '../config/constants'

const router = Router()

router.use(authenticate)

// Parse a single lead-attachment upload, translating multer's errors (chiefly
// file-too-large) into friendly 400s. Mirrors the media library's handler.
const parseLeadFileUpload = (req: Request, res: Response, next: NextFunction) => {
  uploadMedia(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ success: false, message: `File is too large. Maximum size is ${MEDIA_MAX_FILE_SIZE_MB} MB.` })
      }
      return res.status(400).json({ success: false, message: err.message })
    }
    if (err) {
      return res.status(400).json({ success: false, message: (err as Error).message || 'Upload failed' })
    }
    return next()
  })
}

router.post('/import/preview', requireRole('manager', 'representative'), uploadImport, previewLeadImport)
router.post('/import', requireRole('manager', 'representative'), uploadImport, importLeadsFromFile)
router.post('/export', requireManager, requireFeature('exportLeads'), exportLeads)
router.post('/bulk-delete', requireManager, requireFeature('bulkEdit'), [body('ids').isArray({ min: 1 }), body('ids.*').isMongoId()], validate, bulkDeleteLeads)
router.get('/filters', getLeadFilters)
router.get('/follow-up-counts', getFollowUpCounts)
router.get('/pending-assignments', getPendingAssignments)
router.post('/lookup-by-phone', [body('phones').isArray()], validate, lookupLeadsByPhones)

router.get('/', getLeads)

router.post(
  '/bulk-update',
  requireRole('manager', 'representative'),
  requireFeature('bulkEdit'),
  [body('ids').isArray({ min: 1 }), body('ids.*').isMongoId()],
  validate,
  bulkUpdateLeads
)

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

router.delete('/:id', requireDeletePermission, [param('id').isMongoId()], validate, deleteLead)

router.patch(
  '/:id/assign',
  requireRole('manager', 'representative'),
  [param('id').isMongoId(), body('userId').optional({ nullable: true }).isMongoId()],
  validate,
  assignLead
)

router.patch(
  '/:id/assignment-response',
  [param('id').isMongoId(), body('action').isIn(['accept', 'decline'])],
  validate,
  respondToAssignment
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

// Per-lead file attachments (documents, plans, agreements, site photos, ...).
// Every lead — in any status — gets its own file store, separate from the
// shared media library.
router.get('/:id/files', [param('id').isMongoId()], validate, getLeadFiles)
router.post('/:id/files', [param('id').isMongoId()], validate, parseLeadFileUpload, uploadLeadFile)
router.get('/:id/files/:fileId/download', [param('id').isMongoId(), param('fileId').isMongoId()], validate, getLeadFileDownloadUrl)
router.delete('/:id/files/:fileId', [param('id').isMongoId(), param('fileId').isMongoId()], validate, deleteLeadFile)

export default router
