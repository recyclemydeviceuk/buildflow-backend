import crypto from 'crypto'
import { User } from '../models/User'
import { hashPassword, comparePassword } from '../utils/hash'
import { signAccessToken, signRefreshToken } from '../utils/jwt'
import { sendPasswordResetEmail } from './ses.service'
import { FRONTEND_URL } from '../config/constants'
import { logger } from '../utils/logger'

const resetTokens = new Map<string, { userId: string; expires: Date }>()

export const loginUser = async (email: string, password: string) => {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password')
  if (!user) return null
  const valid = await comparePassword(password, user.password)
  if (!valid || !user.isActive) return null

  user.lastLoginAt = new Date()
  await user.save()

  return {
    accessToken: signAccessToken(String(user._id), user.role),
    refreshToken: signRefreshToken(String(user._id)),
    user: { id: user._id, name: user.name, email: user.email, role: user.role, avatarUrl: user.avatarUrl },
  }
}

export const changeUserPassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> => {
  const user = await User.findById(userId).select('+password')
  if (!user) return { success: false, message: 'User not found' }

  const valid = await comparePassword(currentPassword, user.password)
  if (!valid) return { success: false, message: 'Current password is incorrect' }

  user.password = await hashPassword(newPassword)
  await user.save()
  return { success: true, message: 'Password updated' }
}

export const requestPasswordReset = async (email: string): Promise<void> => {
  try {
    const user = await User.findOne({ email: email.toLowerCase() })
    if (!user) return

    const token = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 60 * 60 * 1000)
    resetTokens.set(token, { userId: String(user._id), expires })

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`
    await sendPasswordResetEmail(user.email, resetUrl)
  } catch (err) {
    logger.error('requestPasswordReset error', err)
  }
}

export const resetPassword = async (
  token: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> => {
  const entry = resetTokens.get(token)
  if (!entry) return { success: false, message: 'Invalid or expired token' }
  if (entry.expires < new Date()) {
    resetTokens.delete(token)
    return { success: false, message: 'Token has expired' }
  }

  const user = await User.findById(entry.userId)
  if (!user) return { success: false, message: 'User not found' }

  user.password = await hashPassword(newPassword)
  await user.save()
  resetTokens.delete(token)
  return { success: true, message: 'Password reset successful' }
}
