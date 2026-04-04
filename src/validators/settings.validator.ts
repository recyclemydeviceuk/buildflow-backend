import { body, param } from 'express-validator'

export const updateLeadRoutingValidators = [
  body('mode').optional().isIn(['manual']),
  body('offerTimeout').optional().isInt({ min: 10, max: 600 }),
  body('skipLimit').optional().isInt({ min: 0, max: 20 }),
  body('autoEscalate').optional().isBoolean(),
]

export const createTeamMemberValidators = [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('role').isIn(['manager', 'representative']).withMessage('Role must be manager or representative'),
  body('phone').optional().trim(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('managerKey').optional().isString().trim(),
]

export const updateTeamMemberValidators = [
  param('id').isMongoId().withMessage('Invalid user ID'),
  body('name').optional().notEmpty().trim(),
  body('email').optional().isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('role').optional().isIn(['manager', 'representative']),
  body('isActive').optional().isBoolean(),
  body('phone').optional().trim(),
  body('callAvailabilityStatus').optional().isIn(['available', 'offline', 'in-call']),
  body('callDeviceMode').optional().isIn(['phone', 'web']),
]

export const resetMemberPasswordValidators = [
  param('id').isMongoId().withMessage('Invalid user ID'),
  body('newPassword').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
]

export const updateProfileValidators = [
  body('name').optional().notEmpty().trim(),
  body('email').optional().isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('phone').optional().trim(),
  body('callAvailabilityStatus').optional().isIn(['available', 'offline', 'in-call']),
  body('callDeviceMode').optional().isIn(['phone', 'web']),
  body('notificationPrefs').optional().isObject(),
  body('notificationPrefs.newLeadAlerts').optional().isBoolean(),
  body('notificationPrefs.reminderAlerts').optional().isBoolean(),
  body('notificationPrefs.missedCallAlerts').optional().isBoolean(),
  body('notificationPrefs.assignmentAlerts').optional().isBoolean(),
  body('notificationPrefs.dailyDigest').optional().isBoolean(),
  body('notificationPrefs.loginAlerts').optional().isBoolean(),
]
