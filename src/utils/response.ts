import { Response } from 'express'

export const sendSuccess = <T>(res: Response, data: T, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data })

export const sendPaginated = <T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number
) =>
  res.status(200).json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })

export const sendError = (res: Response, message: string, statusCode = 400) =>
  res.status(statusCode).json({ success: false, message })

export const sendNotFound = (res: Response, entity = 'Resource') =>
  res.status(404).json({ success: false, message: `${entity} not found` })

export const sendUnauthorized = (res: Response, message = 'Unauthorized') =>
  res.status(401).json({ success: false, message })

export const sendForbidden = (res: Response, message = 'Forbidden') =>
  res.status(403).json({ success: false, message })
