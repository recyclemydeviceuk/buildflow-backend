export interface LinkedInOAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

export interface LinkedInUserInfo {
  id: string
  firstName: {
    localized: { [locale: string]: string }
  }
  lastName: {
    localized: { [locale: string]: string }
  }
  emailAddress: string
}

export interface LinkedInIntegration {
  id: string
  userId: string
  personId: string
  firstName: string
  lastName: string
  email: string
  accessToken: string
  refreshToken?: string
  expiresAt: Date
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface LinkedInLeadGenForm {
  id: string
  name: string
  language: string
  country: string
  fields: LinkedInLeadGenFormField[]
  creationTime: Date
  lastModifiedTime: Date
}

export interface LinkedInLeadGenFormField {
  id: string
  name: string
  type: string
  required: boolean
  fieldType: string
  options?: string[]
}

export interface LinkedInLeadGenResponse {
  id: string
  formId: string
  submittedAt: Date
  memberId: string
  firstName?: string
  lastName?: string
  email?: string
  company?: string
  jobTitle?: string
  phone?: string
  customAnswers: {
    questionId: string
    answerText: string
  }[]
  campaignId?: string
  adId?: string
}
