import { Request, Response, NextFunction } from 'express'
import { Settings } from '../models/Settings'
import { normalizeFeatureControls, NormalizedFeatureControls } from '../utils/featureControls'

/**
 * Returns Express middleware that checks whether a feature control flag is enabled.
 * If disabled → 403 with a clear message.
 * Usage: router.use(requireFeature('dialer'))
 */
export const requireFeature = (feature: keyof NormalizedFeatureControls) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await Settings.findOne().select('featureControls').lean()
      const controls = normalizeFeatureControls(settings?.featureControls as Partial<NormalizedFeatureControls> | null)

      if (!controls[feature]) {
        return res.status(403).json({
          success: false,
          message: `This feature (${feature}) is currently disabled by the administrator.`,
        })
      }

      return next()
    } catch (err) {
      // On DB error, fail open (don't block all traffic)
      return next()
    }
  }
}

/**
 * Middleware for lead delete endpoint.
 * - Managers can always delete.
 * - Representatives can delete only when `representativeCanDelete` feature control is ON.
 */
export const requireDeletePermission = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' })
  }

  if (req.user.role === 'manager') {
    return next()
  }

  if (req.user.role === 'representative') {
    try {
      const settings = await Settings.findOne().select('featureControls').lean()
      const controls = normalizeFeatureControls(settings?.featureControls as Partial<NormalizedFeatureControls> | null)

      if (controls.representativeCanDelete) {
        return next()
      }

      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete leads. Contact your manager.',
      })
    } catch {
      return res.status(403).json({ success: false, message: 'Permission check failed.' })
    }
  }

  return res.status(403).json({ success: false, message: 'Insufficient permissions.' })
}
