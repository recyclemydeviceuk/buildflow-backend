import mongoose, { Document, Model, Schema } from 'mongoose'

export interface ISmsMessage extends Document {
  lead: mongoose.Types.ObjectId
  call?: mongoose.Types.ObjectId | null
  phone: string
  from: string
  to: string
  body: string
  direction: 'outbound'
  provider: 'Exotel'
  providerMessageSid?: string | null
  status: 'queued' | 'sending' | 'submitted' | 'sent' | 'failed-dnd' | 'failed'
  detailedStatus?: string | null
  detailedStatusCode?: string | null
  customField?: string | null
  createdBy: mongoose.Types.ObjectId
  createdByName: string
  createdAt: Date
  updatedAt: Date
}

const SmsMessageSchema = new Schema<ISmsMessage>(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    call: { type: Schema.Types.ObjectId, ref: 'Call', default: null, index: true },
    phone: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    body: { type: String, required: true },
    direction: { type: String, enum: ['outbound'], default: 'outbound' },
    provider: { type: String, enum: ['Exotel'], default: 'Exotel' },
    providerMessageSid: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ['queued', 'sending', 'submitted', 'sent', 'failed-dnd', 'failed'],
      default: 'queued',
      index: true,
    },
    detailedStatus: { type: String, default: null },
    detailedStatusCode: { type: String, default: null },
    customField: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true }
)

SmsMessageSchema.index({ lead: 1, createdAt: -1 })
SmsMessageSchema.index({ call: 1, createdAt: -1 })

export const SmsMessage: Model<ISmsMessage> = mongoose.model<ISmsMessage>('SmsMessage', SmsMessageSchema)
