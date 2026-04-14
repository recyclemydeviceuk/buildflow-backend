import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ILeadStatusNote {
  status: string
  note: string
  createdAt: Date
  createdBy?: mongoose.Types.ObjectId | null
  createdByName?: string | null
}

export interface ILead extends Document {
  name: string
  phone: string
  alternatePhone?: string | null
  email?: string | null
  city: string
  source: string
  disposition: string
  meetingType?: 'VC' | 'Client Place' | null
  meetingLocation?: string | null
  failedReason?: string | null
  // Booking Done fields
  bookingPackage?: string | null
  proposedProjectValue?: string | null
  bookingAmountCollected?: string | null
  bookingDate?: Date | null
  numberOfFloors?: string | null
  assignedArchitect?: string | null
  // Agreement Done fields
  agreementProjectValue?: string | null
  agreementDate?: Date | null
  agreementAmount?: string | null
  totalCollection?: string | null
  owner?: mongoose.Types.ObjectId | null
  ownerName?: string | null
  assignedAt?: Date | null
  budget?: string | null
  plotSize?: string | null
  plotSizeUnit?: string | null
  plotOwned?: boolean | null
  buildType?: string | null
  campaign?: string | null
  campaignId?: string | null
  externalId?: string | null
  company?: string | null
  jobTitle?: string | null
  lastActivity?: Date | null
  lastActivityNote?: string | null
  nextFollowUp?: Date | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmTerm?: string | null
  utmContent?: string | null
  metaLeadId?: string | null
  googleClickId?: string | null
  linkedInLeadId?: string | null
  assignmentAcknowledged?: boolean
  skipCount: number
  isInQueue: boolean
  isDuplicate: boolean
  duplicateOf?: mongoose.Types.ObjectId | null
  tags: string[]
  notes?: string | null
  statusNotes: ILeadStatusNote[]
  websiteFormData?: Record<string, string> | null
  createdAt: Date
  updatedAt: Date
}

const LeadStatusNoteSchema = new Schema<ILeadStatusNote>(
  {
    status: {
      type: String,
      enum: ['New', 'Contacted/Open', 'Qualified', 'Visit Done', 'Meeting Done', 'Negotiation Done', 'Booking Done', 'Agreement Done', 'Failed'],
      required: true,
    },
    note: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: null },
  },
  { _id: true }
)

const LeadSchema = new Schema<ILead>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    alternatePhone: { type: String, default: null, trim: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    city: { type: String, required: true, trim: true },
    source: { type: String, required: true },
    disposition: {
      type: String,
      enum: ['New', 'Contacted/Open', 'Qualified', 'Visit Done', 'Meeting Done', 'Negotiation Done', 'Booking Done', 'Agreement Done', 'Failed'],
      default: 'New',
    },
    meetingType: { type: String, enum: ['VC', 'Client Place', null], default: null },
    meetingLocation: { type: String, default: null, trim: true },
    failedReason: { type: String, default: null, trim: true },
    // Booking Done fields
    bookingPackage: { type: String, default: null, trim: true },
    proposedProjectValue: { type: String, default: null, trim: true },
    bookingAmountCollected: { type: String, default: null, trim: true },
    bookingDate: { type: Date, default: null },
    numberOfFloors: { type: String, default: null, trim: true },
    assignedArchitect: { type: String, default: null, trim: true },
    // Agreement Done fields
    agreementProjectValue: { type: String, default: null, trim: true },
    agreementDate: { type: Date, default: null },
    agreementAmount: { type: String, default: null, trim: true },
    totalCollection: { type: String, default: null, trim: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ownerName: { type: String, default: null },
    assignedAt: { type: Date, default: null },
    budget: { type: String, default: null },
    plotSize: { type: String, default: null },
    plotSizeUnit: { type: String, default: null },
    plotOwned: { type: Boolean, default: null },
    buildType: { type: String, default: null },
    campaign: { type: String, default: null },
    campaignId: { type: String, default: null },
    externalId: { type: String, default: null },
    company: { type: String, default: null },
    jobTitle: { type: String, default: null },
    lastActivity: { type: Date, default: null },
    lastActivityNote: { type: String, default: null },
    nextFollowUp: { type: Date, default: null },
    utmSource: { type: String, default: null },
    utmMedium: { type: String, default: null },
    utmCampaign: { type: String, default: null },
    utmTerm: { type: String, default: null },
    utmContent: { type: String, default: null },
    metaLeadId: { type: String, default: null },
    googleClickId: { type: String, default: null },
    linkedInLeadId: { type: String, default: null },
    assignmentAcknowledged: { type: Boolean, default: true },
    skipCount: { type: Number, default: 0 },
    isInQueue: { type: Boolean, default: false },
    isDuplicate: { type: Boolean, default: false },
    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    tags: [{ type: String }],
    notes: { type: String, default: null },
    statusNotes: { type: [LeadStatusNoteSchema], default: [] },
    websiteFormData: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
)

LeadSchema.path('createdAt').immutable(false)

LeadSchema.index({ phone: 1 })
LeadSchema.index({ alternatePhone: 1 })
LeadSchema.index({ owner: 1 })
LeadSchema.index({ disposition: 1 })
LeadSchema.index({ source: 1 })
LeadSchema.index({ city: 1 })
LeadSchema.index({ createdAt: -1 })
LeadSchema.index({ isInQueue: 1 })
LeadSchema.index({ owner: 1, disposition: 1 })
LeadSchema.index({ name: 'text', phone: 'text', alternatePhone: 'text', email: 'text' })

export const Lead: Model<ILead> = mongoose.model<ILead>('Lead', LeadSchema)
