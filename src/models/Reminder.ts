import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IReminder extends Document {
  lead: mongoose.Types.ObjectId
  leadName: string
  owner: mongoose.Types.ObjectId
  ownerName: string
  title: string
  notes?: string | null
  dueAt: Date
  priority: 'high' | 'medium' | 'low'
  status: 'upcoming' | 'due_soon' | 'overdue' | 'completed'
  completedAt?: Date | null
  lastEmailNotificationStatus?: 'due_soon' | 'overdue' | null
  lastEmailNotificationAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const ReminderSchema = new Schema<IReminder>(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadName: { type: String, required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    notes: { type: String, default: null },
    dueAt: { type: Date, required: true },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    status: {
      type: String,
      enum: ['upcoming', 'due_soon', 'overdue', 'completed'],
      default: 'upcoming',
    },
    completedAt: { type: Date, default: null },
    lastEmailNotificationStatus: {
      type: String,
      enum: ['due_soon', 'overdue', null],
      default: null,
    },
    lastEmailNotificationAt: { type: Date, default: null },
  },
  { timestamps: true }
)

ReminderSchema.index({ owner: 1 })
ReminderSchema.index({ lead: 1 })
ReminderSchema.index({ dueAt: 1 })
ReminderSchema.index({ status: 1 })

export const Reminder: Model<IReminder> = mongoose.model<IReminder>('Reminder', ReminderSchema)
