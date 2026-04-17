export interface WhatsAppMessagePayload {
  object: string
  entry: Array<{
    id: string
    changes: Array<{
      value: {
        messaging_product: string
        metadata?: { display_phone_number: string; phone_number_id: string }
        messages?: Array<{
          id: string
          from: string
          timestamp: string
          type: string
          text?: { body: string }
        }>
      }
      field: string
    }>
  }>
}

export interface WebsiteLeadPayload {
  name: string
  phone: string
  email?: string
  city?: string
  campaign?: string
  budget?: string
  message?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmTerm?: string
  utmContent?: string
  /** Google Ads click identifier */
  gclid?: string
  /** Google Ads broad-match click identifier */
  gbraid?: string
  /** Web browser RAID (Google Ads) */
  wbraid?: string
  /** Page URL where the form was submitted */
  landingPage?: string
  /** All raw form fields captured from the website submission (label → value) */
  rawFields?: Record<string, string>
}
