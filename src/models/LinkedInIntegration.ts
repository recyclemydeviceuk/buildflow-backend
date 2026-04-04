import mongoose, { Schema, Document, Model, Types } from 'mongoose'

export interface ILinkedInIntegration extends Document {
  _id: Types.ObjectId
  userId: Types.ObjectId
  personId: string
  firstName: string
  lastName: string
  email: string
  accessToken: string
  refreshToken?: string | null
  expiresAt: Date
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const LinkedInIntegrationSchema = new Schema<ILinkedInIntegration>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    personId: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

LinkedInIntegrationSchema.index({ userId: 1 })
LinkedInIntegrationSchema.index({ personId: 1 })
LinkedInIntegrationSchema.index({ isActive: 1 })

export const LinkedInIntegrationModel: Model<ILinkedInIntegration> = mongoose.model<ILinkedInIntegration>(
  'LinkedInIntegration',
  LinkedInIntegrationSchema
)
