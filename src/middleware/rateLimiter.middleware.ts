import rateLimit from 'express-rate-limit'
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, AUTH_RATE_LIMIT_MAX } from '../config/constants'

// DISABLED: Rate limiters set to very high limits to prevent 429 errors during development
export const globalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 100000, // Effectively unlimited
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
})

export const authRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 100000, // Effectively unlimited
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts, please try again later.' },
})
