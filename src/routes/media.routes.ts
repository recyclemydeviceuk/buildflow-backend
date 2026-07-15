import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { param } from 'express-validator'
import {
  uploadMediaFile,
  getMediaFiles,
  getMediaFileById,
  getMediaDownloadUrl,
  deleteMediaFile,
} from '../controllers/media.controller'
import { authenticate } from '../middleware/auth.middleware'
import { uploadMedia } from '../middleware/multer.middleware'
import { validate } from '../middleware/validate.middleware'
import { MEDIA_MAX_FILE_SIZE_MB } from '../config/constants'

const router = Router()

router.use(authenticate)

// Run the multer parser but translate its errors (chiefly file-too-large) into
// friendly 400s instead of letting them fall through to the generic 500 error
// handler.
const parseMediaUpload = (req: Request, res: Response, next: NextFunction) => {
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

router.post('/', parseMediaUpload, uploadMediaFile)
router.get('/', getMediaFiles)
router.get('/:id/download', [param('id').isMongoId()], validate, getMediaDownloadUrl)
router.get('/:id', [param('id').isMongoId()], validate, getMediaFileById)
router.delete('/:id', [param('id').isMongoId()], validate, deleteMediaFile)

export default router
