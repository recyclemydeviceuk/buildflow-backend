import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IAuditLog extends Document {
  actor: mongoose.Types.ObjectId
  actorName: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  ipAddress?: string | null
  userAgent?: string | null
  createdAt: Date
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

AuditLogSchema.index({ actor: 1 })
AuditLogSchema.index({ entity: 1, entityId: 1 })
AuditLogSchema.index({ action: 1 })
AuditLogSchema.index({ createdAt: -1 })

export const AuditLog: Model<IAuditLog> = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema)
