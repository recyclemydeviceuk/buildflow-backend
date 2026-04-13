import { Express } from 'express-serve-static-core'

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string
        name: string
        email: string
        role: 'manager' | 'representative'
        phone?: string
        callAvailabilityStatus?: 'available' | 'offline' | 'in-call'
        callDeviceMode?: 'phone' | 'web'
        activeCallSid?: string | null
      }
      rawBody?: Buffer
    }
  }
}
