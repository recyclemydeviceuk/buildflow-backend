export interface NormalizedFeatureControls {
  manualAssignment: boolean
  dialer: boolean
  callRecording: boolean
  duplicateDetection: boolean
  autoQueueing: boolean
  smsEnabled: boolean
  whatsappEnabled: boolean
  followUpReminders: boolean
  exportLeads: boolean
  bulkEdit: boolean
  auditLog: boolean
  analyticsAccess: boolean
  representativeCanDelete: boolean
}

export const DEFAULT_FEATURE_CONTROLS: NormalizedFeatureControls = {
  manualAssignment: true,
  dialer: true,
  callRecording: true,
  duplicateDetection: true,
  autoQueueing: true,
  smsEnabled: false,
  whatsappEnabled: false,
  followUpReminders: true,
  exportLeads: true,
  bulkEdit: true,
  auditLog: true,
  analyticsAccess: true,
  representativeCanDelete: false,
}

const bool = (val: unknown, fallback: boolean): boolean =>
  typeof val === 'boolean' ? val : fallback

export const normalizeFeatureControls = (
  raw?: Partial<NormalizedFeatureControls> | null,
  leadRoutingMode?: string | null
): NormalizedFeatureControls => ({
  manualAssignment:
    typeof raw?.manualAssignment === 'boolean'
      ? raw.manualAssignment
      : leadRoutingMode
        ? leadRoutingMode === 'manual'
        : DEFAULT_FEATURE_CONTROLS.manualAssignment,
  dialer: bool(raw?.dialer, DEFAULT_FEATURE_CONTROLS.dialer),
  callRecording: bool(raw?.callRecording, DEFAULT_FEATURE_CONTROLS.callRecording),
  duplicateDetection: bool(raw?.duplicateDetection, DEFAULT_FEATURE_CONTROLS.duplicateDetection),
  autoQueueing: bool(raw?.autoQueueing, DEFAULT_FEATURE_CONTROLS.autoQueueing),
  smsEnabled: bool(raw?.smsEnabled, DEFAULT_FEATURE_CONTROLS.smsEnabled),
  whatsappEnabled: bool(raw?.whatsappEnabled, DEFAULT_FEATURE_CONTROLS.whatsappEnabled),
  followUpReminders: bool(raw?.followUpReminders, DEFAULT_FEATURE_CONTROLS.followUpReminders),
  exportLeads: bool(raw?.exportLeads, DEFAULT_FEATURE_CONTROLS.exportLeads),
  bulkEdit: bool(raw?.bulkEdit, DEFAULT_FEATURE_CONTROLS.bulkEdit),
  auditLog: bool(raw?.auditLog, DEFAULT_FEATURE_CONTROLS.auditLog),
  analyticsAccess: bool(raw?.analyticsAccess, DEFAULT_FEATURE_CONTROLS.analyticsAccess),
  representativeCanDelete: bool(raw?.representativeCanDelete, DEFAULT_FEATURE_CONTROLS.representativeCanDelete),
})
