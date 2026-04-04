import { body, param } from 'express-validator'

export const createReminderValidators = [
  body('leadId').isMongoId().withMessage('Invalid lead ID'),
  body('title').notEmpty().trim().withMessage('Title is required'),
  body('dueAt').isISO8601().withMessage('Valid due date is required'),
  body('priority').optional().isIn(['high', 'medium', 'low']).withMessage('Invalid priority'),
  body('notes').optional().isString(),
]

export const updateReminderValidators = [
  param('id').isMongoId().withMessage('Invalid reminder ID'),
  body('title').optional().notEmpty().trim(),
  body('dueAt').optional().isISO8601().withMessage('Valid due date required'),
  body('priority').optional().isIn(['high', 'medium', 'low']),
]
