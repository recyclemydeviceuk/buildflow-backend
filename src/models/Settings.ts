import mongoose, { Schema, Document, Model } from 'mongoose'
import { DEFAULT_LEAD_FIELD_DEFINITIONS, type LeadFieldDefinition } from '../utils/leadFields'
import { DEFAULT_FEATURE_CONTROLS } from '../utils/featureControls'

export interface ISettings extends Document {
  leadRouting: {
    mode: 'manual' | 'auto'
    offerTimeout: number
    skipLimit: number
    autoEscalate: boolean
  }
  leadFields: {
    plotSizeUnits: string[]
    defaultUnit: string
    buildTypes: string[]
    fields: LeadFieldDefinition[]
  }
  cities: string[]
  featureControls: {
    manualAssignment: boolean
    dialer: boolean
    callRecording: boolean
    duplicateDetection: boolean
    autoQueueing: boolean
    smsEnabled: boolean
    whatsappEnabled: boolean
  }
  notifications: {
    reminderLeadTime: number
    dailyDigestTime: string
    escalationAlertEnabled: boolean
  }
  smsTemplates: Array<{
    id: string
    title: string
    body: string
    isActive: boolean
  }>
  updatedAt: Date
}

const LeadFieldSchema = new Schema<LeadFieldDefinition>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    placeholder: { type: String, default: null },
    type: { type: String, enum: ['text', 'email', 'number', 'select', 'boolean'], required: true },
    section: { type: String, enum: ['core', 'qualification'], required: true },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
)

const SettingsSchema = new Schema<ISettings>(
  {
    leadRouting: {
      mode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      offerTimeout: { type: Number, default: 60 },
      skipLimit: { type: Number, default: 3 },
      autoEscalate: { type: Boolean, default: false },
    },
    leadFields: {
      plotSizeUnits: { type: [String], default: ['sq ft', 'sq yards', 'acres', 'guntha'] },
      defaultUnit: { type: String, default: 'sq ft' },
      buildTypes: { type: [String], default: ['Residential', 'Commercial', 'Villas', 'Apartment', 'Plot'] },
      fields: { type: [LeadFieldSchema], default: DEFAULT_LEAD_FIELD_DEFINITIONS },
    },
    cities: {
      type: [String],
      default: ['Hyderabad', 'Bangalore', 'Mumbai', 'Pune', 'Chennai', 'Delhi', 'Kolkata'],
    },
    featureControls: {
      manualAssignment: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.manualAssignment },
      dialer: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.dialer },
      callRecording: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.callRecording },
      duplicateDetection: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.duplicateDetection },
      autoQueueing: { type: Boolean, default: true },
      smsEnabled: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.smsEnabled },
      whatsappEnabled: { type: Boolean, default: DEFAULT_FEATURE_CONTROLS.whatsappEnabled },
    },
    notifications: {
      reminderLeadTime: { type: Number, default: 30 },
      dailyDigestTime: { type: String, default: '08:00' },
      escalationAlertEnabled: { type: Boolean, default: true },
    },
    smsTemplates: {
      type: [
        {
          id: { type: String, required: true },
          title: { type: String, required: true },
          body: { type: String, required: true },
          isActive: { type: Boolean, default: true },
        },
      ],
      default: [
        {
          id: 'tried-calling',
          title: 'Tried calling',
          body: 'Hi, we tried calling you from BuildFlow. Please reply with a convenient time to connect.',
          isActive: true,
        },
        {
          id: 'thanks',
          title: 'Thanks',
          body: 'Thanks for your interest. We can help with next steps whenever you are ready.',
          isActive: true,
        },
        {
          id: 'callback-time',
          title: 'Callback time',
          body: 'We missed you on the call. Please share a suitable callback time.',
          isActive: true,
        },
      ],
    },
  },
  { timestamps: true }
)

export const Settings: Model<ISettings> = mongoose.model<ISettings>('Settings', SettingsSchema)
