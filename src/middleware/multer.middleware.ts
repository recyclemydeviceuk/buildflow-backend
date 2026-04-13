import multer from 'multer'
import { IMPORT_ALLOWED_MIME_TYPES, IMPORT_MAX_FILE_SIZE_MB } from '../config/constants'

const storage = multer.memoryStorage()

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG and WebP images are allowed'))
    }
  },
}).single('avatar')

export const uploadImport = multer({
  storage,
  limits: { fileSize: IMPORT_MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMPORT_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only CSV and Excel files are allowed'))
    }
  },
}).single('file')
