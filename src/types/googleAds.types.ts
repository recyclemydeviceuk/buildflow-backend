export interface GoogleAdsOAuthTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

export interface GoogleAdsUserInfo {
  id: string
  email: string
  name: string
  picture: string
  verified_email: boolean
}

export interface GoogleAdsIntegration {
  id: string
  userId: string
  customerId: string
  customerName: string
  accessToken: string
  refreshToken: string
  expiresAt: Date
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface GoogleAdsLeadForm {
  id: string
  name: string
  status: string
  fields: GoogleAdsLeadFormField[]
  campaignId: string
  campaignName: string
  adGroupId: string
  adGroupName: string
}

export interface GoogleAdsLeadFormField {
  id: string
  name: string
  type: string
  required: boolean
  answers?: string[]
}

export interface GoogleAdsLead {
  id: string
  formId: string
  campaignId: string
  adGroupId: string
  submittedAt: Date
  fields: {
    [key: string]: string
  }
  gclid?: string
}
