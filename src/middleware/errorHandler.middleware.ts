import { Request, Response, NextFunction } from 'express'
import { NODE_ENV } from '../config/constants'

interface AppError extends Error {
  statusCode?: number
  isOperational?: boolean
}

export const errorHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err.statusCode || 500
  const message = err.message || 'Internal Server Error'

  if (NODE_ENV === 'development') {
    return res.status(statusCode).json({
      success: false,
      message,
      stack: err.stack,
    })
  }

  return res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? 'Internal Server Error' : message,
  })
}

export const notFound = (_req: Request, res: Response) => {
  return res.status(404).json({ success: false, message: 'Route not found' })
}
