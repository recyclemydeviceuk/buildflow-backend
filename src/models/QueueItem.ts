import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IQueueItem extends Document {
  leadId: mongoose.Types.ObjectId
  leadName: string
  phone: string
  city: string
  source: string
  segment: 'Unassigned' | 'Timed Out' | 'Skipped' | 'Escalated'
  status: 'waiting' | 'offered' | 'assigned' | 'on_hold' | 'completed' | 'invalid' | 'escalated'
  urgency: number
  offeredTo?: mongoose.Types.ObjectId | null
  offeredToName?: string | null
  offeredAt?: Date | null
  offerExpiresAt?: Date | null
  assignedTo?: mongoose.Types.ObjectId | null
  assignedToName?: string | null
  assignedAt?: Date | null
  skipCount: number
  lastSkippedBy?: mongoose.Types.ObjectId | null
  lastSkippedAt?: Date | null
  holdUntil?: Date | null
  notes?: string | null
  createdAt: Date
  updatedAt: Date
}

const QueueItemSchema = new Schema<IQueueItem>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadName: { type: String, required: true },
    phone: { type: String, required: true },
    city: { type: String, required: true },
    source: { type: String, required: true },
    segment: {
      type: String,
      enum: ['Unassigned', 'Timed Out', 'Skipped', 'Escalated'],
      default: 'Unassigned',
    },
    status: {
      type: String,
      enum: ['waiting', 'offered', 'assigned', 'on_hold', 'completed', 'invalid', 'escalated'],
      default: 'waiting',
    },
    urgency: { type: Number, default: 1 },
    offeredTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    offeredToName: { type: String, default: null },
    offeredAt: { type: Date, default: null },
    offerExpiresAt: { type: Date, default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedToName: { type: String, default: null },
    assignedAt: { type: Date, default: null },
    skipCount: { type: Number, default: 0 },
    lastSkippedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    lastSkippedAt: { type: Date, default: null },
    holdUntil: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true }
)

QueueItemSchema.index({ status: 1 })
QueueItemSchema.index({ segment: 1 })
QueueItemSchema.index({ leadId: 1 })
QueueItemSchema.index({ assignedTo: 1 })
QueueItemSchema.index({ offeredTo: 1 })
QueueItemSchema.index({ urgency: -1, createdAt: 1 })

export const QueueItem: Model<IQueueItem> = mongoose.model<IQueueItem>('QueueItem', QueueItemSchema)
