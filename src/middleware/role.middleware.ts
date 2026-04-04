import { Request, Response, NextFunction } from 'express'

export const requireManager = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' })
  }
  if (req.user.role !== 'manager') {
    return res.status(403).json({ success: false, message: 'Manager access required' })
  }
  return next()
}

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' })
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `Access restricted to: ${roles.join(', ')}` })
    }
    return next()
  }
}
