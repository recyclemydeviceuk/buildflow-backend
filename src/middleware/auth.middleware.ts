import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../config/constants'
import { User } from '../models/User'

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token: string | undefined

    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1]
    } else if (req.query.token) {
      token = String(req.query.token)
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' })
    }

    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload

    const user = await User.findById(decoded.sub).select(
      'name email role phone isActive isDemo callAvailabilityStatus callDeviceMode activeCallSid'
    )
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or deactivated' })
    }

    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      callAvailabilityStatus: user.callAvailabilityStatus,
      callDeviceMode: user.callDeviceMode,
      activeCallSid: user.activeCallSid,
      isDemo: Boolean(user.isDemo),
    }

    // ── Demo/read-only gate ─────────────────────────────────────────────
    // Demo accounts can read anything but cannot mutate anything. We enforce
    // this in ONE place (here) so no future write endpoint can accidentally
    // bypass the rule. Allow safe methods always; block everything else.
    const method = req.method.toUpperCase()
    const isSafeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
    if (user.isDemo && !isSafeMethod) {
      return res.status(403).json({
        success: false,
        message: 'Demo account is view-only. Editing is disabled.',
        code: 'DEMO_READ_ONLY',
      })
    }

    return next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' })
    }
    return next(err)
  }
}
