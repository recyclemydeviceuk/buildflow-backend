export const exotelConfig = {
  apiKey: process.env.EXOTEL_API_KEY!,
  apiToken: process.env.EXOTEL_API_TOKEN!,
  accountSid: process.env.EXOTEL_ACCOUNT_SID!,
  subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',

  get baseUrl(): string {
    return `https://${this.apiKey}:${this.apiToken}@${this.subdomain}/v1/Accounts/${this.accountSid}`
  },

  get ccmSubdomain(): string {
    if (this.subdomain.startsWith('ccm-api')) return this.subdomain
    return this.subdomain.replace(/^api/, 'ccm-api')
  },

  get voiceV3BaseUrl(): string {
    return `https://${this.apiKey}:${this.apiToken}@${this.ccmSubdomain}/v3/accounts/${this.accountSid}`
  },

  callbackBaseUrl: process.env.APP_BASE_URL || 'https://api.buildflow.in',

  get statusCallbackUrl(): string {
    return `${this.callbackBaseUrl}/api/webhooks/exotel/call-status`
  },

  get smsStatusCallbackUrl(): string {
    return `${this.callbackBaseUrl}/api/webhooks/exotel/sms-status`
  },

  exoPhone: process.env.EXOTEL_EXOPHONE!,
  smsFrom: process.env.EXOTEL_SMS_FROM || process.env.EXOTEL_EXOPHONE!,
  exoPhones: (process.env.EXOTEL_EXOPHONES || '').split(',').map(p => p.trim()).filter(Boolean),
  smsDltEntityId: process.env.EXOTEL_SMS_DLT_ENTITY_ID || '',
  smsDltTemplateId: process.env.EXOTEL_SMS_DLT_TEMPLATE_ID || '',
  smsType: (process.env.EXOTEL_SMS_TYPE as 'transactional' | 'transactional_opt_in' | 'promotional' | undefined) || undefined,

  recordingEnabled: process.env.EXOTEL_RECORDING_ENABLED === 'true',
  recordingChannels: (process.env.EXOTEL_RECORDING_CHANNELS as 'dual' | 'single') || 'dual',

  get analysisCategories(): string[] {
    const env = process.env.EXOTEL_ANALYSIS_CATEGORIES
    if (env) return env.split(',').map((c) => c.trim()).filter(Boolean)
    return ['Interested', 'Not Interested', 'Call Back Later', 'Wrong Number', 'Voicemail', 'Qualified Lead']
  },
}
