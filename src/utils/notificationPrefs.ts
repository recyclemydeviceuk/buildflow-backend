export interface NotificationPreferences {
  newLeadAlerts: boolean
  reminderAlerts: boolean
  missedCallAlerts: boolean
  assignmentAlerts: boolean
  dailyDigest: boolean
  loginAlerts: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  newLeadAlerts: true,
  reminderAlerts: true,
  missedCallAlerts: true,
  assignmentAlerts: true,
  dailyDigest: false,
  loginAlerts: false,
}

export const normalizeNotificationPrefs = (
  prefs?: Partial<NotificationPreferences> | null | any
): NotificationPreferences => {
  // Extract actual values from Mongoose document or plain object
  const raw = prefs?._doc || prefs || {}
  
  return {
    newLeadAlerts: raw.newLeadAlerts ?? DEFAULT_NOTIFICATION_PREFS.newLeadAlerts,
    reminderAlerts: raw.reminderAlerts ?? DEFAULT_NOTIFICATION_PREFS.reminderAlerts,
    missedCallAlerts: raw.missedCallAlerts ?? DEFAULT_NOTIFICATION_PREFS.missedCallAlerts,
    assignmentAlerts: raw.assignmentAlerts ?? DEFAULT_NOTIFICATION_PREFS.assignmentAlerts,
    dailyDigest: raw.dailyDigest ?? DEFAULT_NOTIFICATION_PREFS.dailyDigest,
    loginAlerts: raw.loginAlerts ?? DEFAULT_NOTIFICATION_PREFS.loginAlerts,
  }
}
