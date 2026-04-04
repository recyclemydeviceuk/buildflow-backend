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
  lastLoginAt?: Date
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
    lastLoginAt: { type: Date },
    notificationPrefs: { type: NotificationPrefsSchema, default: () => ({ ...DEFAULT_NOTIFICATION_PREFS }) },
  },
  { timestamps: true }
)

UserSchema.index({ email: 1 })
UserSchema.index({ role: 1 })
UserSchema.index({ isActive: 1 })

export const User: Model<IUser> = mongoose.model<IUser>('User', UserSchema)
