import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ICall extends Document {
  lead: mongoose.Types.ObjectId
  leadName: string
  phone: string
  representative: mongoose.Types.ObjectId
  representativeName: string
  exophoneNumber?: string | null
  exotelCallSid?: string | null
  exotelStatusRaw?: string | null
  direction?: string | null
  status: string
  outcome?: string | null
  representativeLegStatus?: string | null
  customerLegStatus?: string | null
  representativeAnswered?: boolean | null
  customerAnswered?: boolean | null
  stage?: string | null
  duration?: number
  recordingRequested?: boolean | null
  recordingUrl?: string | null
  recordingS3Key?: string | null
  startedAt?: Date | null
  endedAt?: Date | null
  notes?: string | null
  missedCallAlertSentAt?: Date | null
  feedbackSubmittedAt?: Date | null
  feedback?: {
    interested?: boolean
    callBackAt?: Date | null
    reason?: string | null
  }
  aiAnalysisStatus?: 'pending' | 'processing' | 'completed' | 'failed' | null
  aiJobId?: string | null
  transcript?: string | null
  summary?: string | null
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | null
  sentimentConfidence?: number | null
  aiCategory?: string | null
  aiCategoryConfidence?: number | null
  createdAt: Date
  updatedAt: Date
}

const CallSchema = new Schema<ICall>(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadName: { type: String, required: true },
    phone: { type: String, required: true },
    representative: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    representativeName: { type: String, required: true },
    exophoneNumber: { type: String, default: null },
    exotelCallSid: { type: String, default: null },
    exotelStatusRaw: { type: String, default: null },
    direction: { type: String, enum: ['incoming', 'outbound'], default: null },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer', 'busy', 'canceled'],
      default: 'initiated',
    },
    outcome: {
      type: String,
      enum: ['Connected', 'Not Answered', 'Busy', 'Wrong Number', 'Call Back Later', 'Voicemail', null],
      default: null,
    },
    representativeLegStatus: { type: String, default: null },
    customerLegStatus: { type: String, default: null },
    representativeAnswered: { type: Boolean, default: null },
    customerAnswered: { type: Boolean, default: null },
    stage: { type: String, default: null },
    duration: { type: Number, default: 0 },
    recordingRequested: { type: Boolean, default: null },
    recordingUrl: { type: String, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    notes: { type: String, default: null },
    missedCallAlertSentAt: { type: Date, default: null },
    feedbackSubmittedAt: { type: Date, default: null },
    feedback: {
      interested: { type: Boolean },
      callBackAt: { type: Date, default: null },
      reason: { type: String, default: null },
    },
    recordingS3Key: { type: String, default: null },
    aiAnalysisStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', null],
      default: null,
    },
    aiJobId: { type: String, default: null },
    transcript: { type: String, default: null },
    summary: { type: String, default: null },
    sentiment: {
      type: String,
      enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL', null],
      default: null,
    },
    sentimentConfidence: { type: Number, default: null },
    aiCategory: { type: String, default: null },
    aiCategoryConfidence: { type: Number, default: null },
  },
  { timestamps: true }
)

CallSchema.index({ lead: 1 })
CallSchema.index({ representative: 1 })
CallSchema.index({ exotelCallSid: 1 }, { unique: true, sparse: true })
CallSchema.index({ startedAt: -1, createdAt: -1 })
CallSchema.index({ outcome: 1 })

export const Call: Model<ICall> = mongoose.model<ICall>('Call', CallSchema)
