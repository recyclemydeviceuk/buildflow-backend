import { Router } from 'express'
import { param } from 'express-validator'
import {
  uploadAvatar,
  deleteAvatar,
  uploadImportFile,
  getImportJobs,
  getImportJobById,
} from '../controllers/upload.controller'
import { authenticate } from '../middleware/auth.middleware'
import { uploadAvatar as multerAvatar, uploadImport as multerImport } from '../middleware/multer.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate)

router.post('/avatar', multerAvatar, uploadAvatar)
router.delete('/avatar', deleteAvatar)

router.post('/import', multerImport, uploadImportFile)
router.get('/import', getImportJobs)
router.get('/import/:id', [param('id').isMongoId()], validate, getImportJobById)

export default router
