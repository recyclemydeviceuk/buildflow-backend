import { Router } from 'express'
import { body, param } from 'express-validator'
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  markReminderDone,
  getOverdueReminders,
} from '../controllers/reminder.controller'
import { authenticate } from '../middleware/auth.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.use(authenticate)

router.get('/', getReminders)

router.get('/overdue', getOverdueReminders)

router.get('/:id', [param('id').isMongoId()], validate, getReminderById)

router.post(
  '/',
  [
    body('leadId').isMongoId(),
    body('title').notEmpty().trim(),
    body('dueAt').isISO8601(),
  ],
  validate,
  createReminder
)

router.put('/:id', [param('id').isMongoId()], validate, updateReminder)

router.delete('/:id', [param('id').isMongoId()], validate, deleteReminder)

router.patch('/:id/done', [param('id').isMongoId()], validate, markReminderDone)

export default router
