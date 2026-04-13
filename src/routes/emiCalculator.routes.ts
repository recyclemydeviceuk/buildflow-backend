import { Router } from 'express'
import { body, param } from 'express-validator'
import {
  getEmiCalculations,
  saveEmiCalculation,
  deleteEmiCalculation,
  sendEmiCalculationEmail,
} from '../controllers/emiCalculator.controller'
import { authenticate } from '../middleware/auth.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

// All routes require authentication (both managers and representatives)
router.use(authenticate)

// GET /api/emi-calculator — list calculations (own for rep, all for manager)
router.get('/', getEmiCalculations)

// POST /api/emi-calculator — save a new calculation
router.post(
  '/',
  [
    body('loanAmount').isFloat({ min: 1 }).withMessage('Loan amount must be a positive number'),
    body('interestRate').isFloat({ min: 0.01, max: 100 }).withMessage('Interest rate must be between 0.01 and 100'),
    body('tenureYears').isInt({ min: 1 }).withMessage('Tenure in years must be at least 1'),
    body('tenureMonths').isInt({ min: 1 }).withMessage('Tenure in months must be at least 1'),
    body('monthlyEmi').isFloat({ min: 0 }).withMessage('Monthly EMI must be a positive number'),
    body('totalAmount').isFloat({ min: 0 }).withMessage('Total amount must be a positive number'),
    body('totalInterest').isFloat({ min: 0 }).withMessage('Total interest must be a positive number'),
    body('notes').optional().isString().trim(),
  ],
  validate,
  saveEmiCalculation
)

// DELETE /api/emi-calculator/:id — delete a calculation
router.delete(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid calculation ID')],
  validate,
  deleteEmiCalculation
)

// POST /api/emi-calculator/:id/send-email — email the calculation
router.post(
  '/:id/send-email',
  [
    param('id').isMongoId().withMessage('Invalid calculation ID'),
    body('recipientEmail').isEmail().normalizeEmail().withMessage('Valid recipient email is required'),
  ],
  validate,
  sendEmiCalculationEmail
)

export default router
