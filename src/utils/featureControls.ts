export interface NormalizedFeatureControls {
  manualAssignment: boolean
  dialer: boolean
  callRecording: boolean
  duplicateDetection: boolean
  smsEnabled: boolean
  whatsappEnabled: boolean
}

export const DEFAULT_FEATURE_CONTROLS: NormalizedFeatureControls = {
  manualAssignment: true,
  dialer: true,
  callRecording: true,
  duplicateDetection: true,
  smsEnabled: false,
  whatsappEnabled: false,
}

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
  dialer: typeof raw?.dialer === 'boolean' ? raw.dialer : DEFAULT_FEATURE_CONTROLS.dialer,
  callRecording:
    typeof raw?.callRecording === 'boolean' ? raw.callRecording : DEFAULT_FEATURE_CONTROLS.callRecording,
  duplicateDetection:
    typeof raw?.duplicateDetection === 'boolean'
      ? raw.duplicateDetection
      : DEFAULT_FEATURE_CONTROLS.duplicateDetection,
  smsEnabled: typeof raw?.smsEnabled === 'boolean' ? raw.smsEnabled : DEFAULT_FEATURE_CONTROLS.smsEnabled,
  whatsappEnabled:
    typeof raw?.whatsappEnabled === 'boolean' ? raw.whatsappEnabled : DEFAULT_FEATURE_CONTROLS.whatsappEnabled,
})
