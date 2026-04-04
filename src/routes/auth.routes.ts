import { Router } from 'express'
import { body } from 'express-validator'
import {
  login,
  refreshToken,
  logout,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
} from '../controllers/auth.controller'
import { authenticate } from '../middleware/auth.middleware'
import { authRateLimiter } from '../middleware/rateLimiter.middleware'
import { validate } from '../middleware/validate.middleware'

const router = Router()

router.post(
  '/login',
  authRateLimiter,
  [body('email').isEmail(), body('password').notEmpty()],
  validate,
  login
)

router.post('/refresh', [body('refreshToken').notEmpty()], validate, refreshToken)

router.post('/logout', authenticate, logout)

router.get('/me', authenticate, getMe)

router.patch(
  '/change-password',
  authenticate,
  [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 8 })],
  validate,
  changePassword
)

router.post(
  '/forgot-password',
  authRateLimiter,
  [body('email').isEmail()],
  validate,
  forgotPassword
)

router.post(
  '/reset-password',
  [body('token').notEmpty(), body('newPassword').isLength({ min: 8 })],
  validate,
  resetPassword
)

export default router
