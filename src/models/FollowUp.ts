import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IFollowUp extends Document {
  lead: mongoose.Types.ObjectId
  leadName: string
  owner: mongoose.Types.ObjectId
  ownerName: string
  scheduledAt: Date
  notes?: string | null
  status: 'pending' | 'completed' | 'cancelled'
  completedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const FollowUpSchema = new Schema<IFollowUp>(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadName: { type: String, required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, required: true },
    scheduledAt: { type: Date, required: true },
    notes: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'completed', 'cancelled'],
      default: 'pending',
    },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
)

FollowUpSchema.index({ lead: 1 })
FollowUpSchema.index({ owner: 1 })
FollowUpSchema.index({ scheduledAt: 1 })
FollowUpSchema.index({ status: 1 })

export const FollowUp: Model<IFollowUp> = mongoose.model<IFollowUp>('FollowUp', FollowUpSchema)
