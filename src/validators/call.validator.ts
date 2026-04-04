import { body, param } from 'express-validator'

export const initiateCallValidators = [
  body('leadId').isMongoId().withMessage('Invalid lead ID'),
  body('phone').notEmpty().trim().withMessage('Phone number is required'),
]

export const callFeedbackValidators = [
  param('id').isMongoId().withMessage('Invalid call ID'),
  body('outcome').notEmpty().withMessage('Outcome is required'),
  body('callBackAt').optional().isISO8601().withMessage('Invalid callback date'),
  body('interested').optional().isBoolean(),
]
