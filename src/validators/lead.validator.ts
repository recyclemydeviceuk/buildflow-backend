import { body, param, query } from 'express-validator'

export const createLeadValidators = [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('phone').notEmpty().trim().withMessage('Phone is required'),
  body('city').notEmpty().trim().withMessage('City is required'),
  body('source').notEmpty().withMessage('Source is required'),
  body('email').optional().isEmail().withMessage('Valid email required'),
  body('budget').optional().isString(),
  body('plotSize').optional().isNumeric(),
  body('plotOwned').optional().isBoolean(),
]

export const updateLeadValidators = [
  param('id').isMongoId().withMessage('Invalid lead ID'),
  body('name').optional().notEmpty().trim(),
  body('email').optional().isEmail().withMessage('Valid email required'),
  body('phone').optional().notEmpty().trim(),
]

export const assignLeadValidators = [
  param('id').isMongoId().withMessage('Invalid lead ID'),
  body('userId').isMongoId().withMessage('Invalid user ID'),
]

export const updateDispositionValidators = [
  param('id').isMongoId().withMessage('Invalid lead ID'),
  body('disposition').notEmpty().withMessage('Disposition is required'),
]

export const listLeadsValidators = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
]
