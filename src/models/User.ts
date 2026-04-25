import mongoose, { Schema, Document, Model } from 'mongoose'
import { DEFAULT_NOTIFICATION_PREFS, NotificationPreferences } from '../utils/notificationPrefs'

export interface IUser extends Document {
  name: string
  email: string
  password: string
  role: 'manager' | 'representative'
  phone?: string
  callAvailabilityStatus?: 'available' | 'offline' | 'in-call'
  callDeviceMode?: 'phone' | 'web'
  activeCallSid?: string | null
  passwordResetToken?: string | null
  passwordResetExpires?: Date | null
  avatarUrl?: string | null
  isActive: boolean
  // Lead-receiving switch (managers only toggle this). When false the
  // round-robin + city-rule routers skip this rep — they keep their existing
  // leads and stay fully active in every other way (calls, follow-ups, etc.).
  // Default: true. Distinct from `isActive`, which deactivates the account
  // entirely.
  canReceiveLeads?: boolean
  // Demo / read-only flag. When true, the backend blocks ALL non-GET requests
  // for this user (enforced centrally in auth.middleware.ts). The frontend
  // reads this flag and shows a persistent "read-only" banner. Default: false.
  isDemo?: boolean
  lastLoginAt?: Date
  // Timestamp of the last time this rep was auto-routed a lead.
  // Used by the round-robin algorithm to pick the rep who has waited longest.
  lastAssignedLeadAt?: Date | null
  notificationPrefs?: NotificationPreferences
  createdAt: Date
  updatedAt: Date
}

const NotificationPrefsSchema = new Schema<NotificationPreferences>(
  {
    newLeadAlerts: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.newLeadAlerts },
    reminderAlerts: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.reminderAlerts },
    missedCallAlerts: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.missedCallAlerts },
    assignmentAlerts: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.assignmentAlerts },
    dailyDigest: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.dailyDigest },
    loginAlerts: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.loginAlerts },
  },
  { _id: false }
)

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['manager', 'representative'], required: true },
    phone: { type: String, trim: true },
    callAvailabilityStatus: {
      type: String,
      enum: ['available', 'offline', 'in-call'],
      default: 'available',
    },
    callDeviceMode: {
      type: String,
      enum: ['phone', 'web'],
      default: 'phone',
    },
    activeCallSid: { type: String, default: null },
    passwordResetToken: { type: String, default: null },
    passwordResetExpires: { type: Date, default: null },
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    canReceiveLeads: { type: Boolean, default: true },
    isDemo: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    lastAssignedLeadAt: { type: Date, default: null },
    notificationPrefs: { type: NotificationPrefsSchema, default: () => ({ ...DEFAULT_NOTIFICATION_PREFS }) },
  },
  { timestamps: true }
)

UserSchema.index({ email: 1 })
UserSchema.index({ role: 1 })
UserSchema.index({ isActive: 1 })
// Compound index powering the round-robin ordering query.
UserSchema.index({ role: 1, isActive: 1, lastAssignedLeadAt: 1 })

export const User: Model<IUser> = mongoose.model<IUser>('User', UserSchema)
