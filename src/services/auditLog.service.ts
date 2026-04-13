import { AuditLog } from '../models/AuditLog'
import { logger } from '../utils/logger'

interface LogActionParams {
  actorId: string
  actorName: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  ipAddress?: string
  userAgent?: string
}

export const logAction = async (params: LogActionParams): Promise<void> => {
  try {
    await AuditLog.create({
      actor: params.actorId,
      actorName: params.actorName,
      actorRole: params.actorRole,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      before: params.before || null,
      after: params.after || null,
      ipAddress: params.ipAddress || null,
      userAgent: params.userAgent || null,
    })
  } catch (err) {
    logger.error('auditLog.service logAction error', err)
  }
}
