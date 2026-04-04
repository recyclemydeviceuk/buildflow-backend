import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IIntegration extends Document {
  provider: 'meta' | 'google' | 'linkedin' | 'whatsapp' | 'exotel'
  status: 'connected' | 'disconnected' | 'error'
  accessToken?: string | null
  refreshToken?: string | null
  appSecret?: string | null
  externalAccountId?: string | null
  externalAccountName?: string | null
  tokenExpiresAt?: Date | null
  connectedAt?: Date | null
  connectedBy?: mongoose.Types.ObjectId | null
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const IntegrationSchema = new Schema<IIntegration>(
  {
    provider: {
      type: String,
      enum: ['meta', 'google', 'linkedin', 'whatsapp', 'exotel'],
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['connected', 'disconnected', 'error'],
      default: 'disconnected',
    },
    accessToken: { type: String, default: null, select: false },
    refreshToken: { type: String, default: null, select: false },
    appSecret: { type: String, default: null, select: false },
    externalAccountId: { type: String, default: null },
    externalAccountName: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
)

IntegrationSchema.index({ provider: 1 })
IntegrationSchema.index({ status: 1 })

export const Integration: Model<IIntegration> = mongoose.model<IIntegration>('Integration', IntegrationSchema)
