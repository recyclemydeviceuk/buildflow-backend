import mongoose, { Schema, Document, Model, Types } from 'mongoose'

export interface IGoogleAdsIntegration extends Document {
  _id: Types.ObjectId
  userId: Types.ObjectId
  customerId: string
  customerName: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const GoogleAdsIntegrationSchema = new Schema<IGoogleAdsIntegration>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: String, required: true },
    customerName: { type: String, required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

GoogleAdsIntegrationSchema.index({ userId: 1 })
GoogleAdsIntegrationSchema.index({ customerId: 1 })
GoogleAdsIntegrationSchema.index({ isActive: 1 })

export const GoogleAdsIntegrationModel: Model<IGoogleAdsIntegration> = mongoose.model<IGoogleAdsIntegration>(
  'GoogleAdsIntegration',
  GoogleAdsIntegrationSchema
)
