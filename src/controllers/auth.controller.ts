import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { User } from '../models/User'
import {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
  BCRYPT_SALT_ROUNDS,
  FRONTEND_URL,
} from '../config/constants'
import { sendLoginNotificationEmail, sendPasswordResetEmail } from '../services/ses.service'
import { normalizeNotificationPrefs } from '../utils/notificationPrefs'

const signAccessToken = (userId: string, role: string) =>
  jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions)

const signRefreshToken = (userId: string) =>
  jwt.sign({ sub: userId }, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions)

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password')
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' })
    }

    const isMatch = await bcrypt.compare(password, user.password)
    
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' })
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated' })
    }

    user.lastLoginAt = new Date()
    await user.save()

    if (normalizeNotificationPrefs(user.notificationPrefs).loginAlerts) {
      void sendLoginNotificationEmail(
        user.email,
        user.name,
        user.lastLoginAt,
        req.ip || req.headers['x-forwarded-for']?.toString() || 'Unknown',
        req.headers['user-agent'] || 'Unknown device'
      ).catch(() => null)
    }

    const accessToken = signAccessToken(String(user._id), user.role)
    const refreshToken = signRefreshToken(String(user._id))

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone,
          callAvailabilityStatus: user.callAvailabilityStatus,
          callDeviceMode: user.callDeviceMode,
          activeCallSid: user.activeCallSid,
          isActive: user.isActive,
          avatarUrl: user.avatarUrl,
          notificationPrefs: normalizeNotificationPrefs(user.notificationPrefs),
        },
      },
    })
  } catch (err) {
    next(err)
  }
}

export const refreshToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken: token } = req.body
    if (!token) {
      return res.status(400).json({ success: false, message: 'Refresh token is required' })
    }

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as jwt.JwtPayload
    const user = await User.findById(decoded.sub)
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' })
    }

    const accessToken = signAccessToken(String(user._id), user.role)
    return res.status(200).json({ success: true, data: { accessToken } })
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' })
    }
    next(err)
  }
}

export const logout = async (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, message: 'Logged out successfully' })
}

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.user!.id)
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }
    
    const normalized = normalizeNotificationPrefs(user.notificationPrefs)
    
    return res.status(200).json({
      success: true,
      data: {
        ...user.toObject(),
        notificationPrefs: normalized,
      },
    })
  } catch (err) {
    next(err)
  }
}

export const changePassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body

    const user = await User.findById(req.user!.id).select('+password')
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' })
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS)
    await user.save()

    return res.status(200).json({ success: true, message: 'Password changed successfully' })
  } catch (err) {
    next(err)
  }
}

export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body
    const user = await User.findOne({ email: email.toLowerCase() })

    if (user) {
      const resetToken = jwt.sign({ sub: user._id, purpose: 'reset' }, JWT_SECRET, { expiresIn: '1h' } as jwt.SignOptions)
      user.passwordResetToken = resetToken
      user.passwordResetExpires = new Date(Date.now() + 3600000)
      await user.save()

      const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(resetToken)}`
      void sendPasswordResetEmail(user.email, resetUrl, user.name).catch(() => null)
    }

    return res.status(200).json({
      success: true,
      message: 'If that email exists, a password reset link has been sent.',
    })
  } catch (err) {
    next(err)
  }
}

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = req.body

    let decoded: jwt.JwtPayload
    try {
      decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' })
    }

    const user = await User.findOne({
      _id: decoded.sub,
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
    })

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' })
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS)
    user.passwordResetToken = undefined
    user.passwordResetExpires = undefined
    await user.save()

    return res.status(200).json({ success: true, message: 'Password reset successfully' })
  } catch (err) {
    next(err)
  }
}
