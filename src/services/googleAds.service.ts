import axios from 'axios'
import { googleAdsConfig } from '../config/googleAds'
import { GoogleAdsOAuthTokenResponse, GoogleAdsUserInfo, GoogleAdsLeadForm, GoogleAdsLead } from '../types/googleAds.types'
import { GoogleAdsIntegrationModel } from '../models/GoogleAdsIntegration'
import { logger } from '../utils/logger'

export const getGoogleAdsAuthUrl = (): string => {
  return googleAdsConfig.authUrl
}

export const exchangeGoogleAdsCode = async (code: string): Promise<GoogleAdsOAuthTokenResponse | null> => {
  try {
    const response = await axios.post<GoogleAdsOAuthTokenResponse>(
      googleAdsConfig.tokenUrl,
      new URLSearchParams({
        code,
        client_id: googleAdsConfig.clientId,
        client_secret: googleAdsConfig.clientSecret,
        redirect_uri: googleAdsConfig.redirectUri,
        grant_type: 'authorization_code'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    return response.data
  } catch (err) {
    logger.error('Google Ads token exchange error', err)
    return null
  }
}

export const getGoogleAdsUserInfo = async (accessToken: string): Promise<GoogleAdsUserInfo | null> => {
  try {
    const response = await axios.get<GoogleAdsUserInfo>(
      googleAdsConfig.userInfoUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    return response.data
  } catch (err) {
    logger.error('Google Ads user info error', err)
    return null
  }
}

export const refreshGoogleAdsToken = async (refreshToken: string): Promise<GoogleAdsOAuthTokenResponse | null> => {
  try {
    const response = await axios.post<GoogleAdsOAuthTokenResponse>(
      googleAdsConfig.tokenUrl,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: googleAdsConfig.clientId,
        client_secret: googleAdsConfig.clientSecret,
        grant_type: 'refresh_token'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    return response.data
  } catch (err) {
    logger.error('Google Ads token refresh error', err)
    return null
  }
}

export const saveGoogleAdsIntegration = async (
  userId: string,
  tokens: GoogleAdsOAuthTokenResponse,
  userInfo: GoogleAdsUserInfo,
  customerId: string,
  customerName: string
): Promise<void> => {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  
  await GoogleAdsIntegrationModel.findOneAndUpdate(
    { userId },
    {
      userId,
      customerId,
      customerName,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token!,
      expiresAt,
      isActive: true
    },
    { upsert: true, new: true }
  )
}

export const getGoogleAdsIntegration = async (userId: string) => {
  return GoogleAdsIntegrationModel.findOne({ userId, isActive: true })
}

export const getValidGoogleAdsToken = async (userId: string): Promise<string | null> => {
  const integration = await getGoogleAdsIntegration(userId)
  if (!integration) return null
  
  // Check if token is expired
  if (integration.expiresAt <= new Date()) {
    if (!integration.refreshToken) return null
    
    const newTokens = await refreshGoogleAdsToken(integration.refreshToken)
    if (!newTokens) return null
    
    // Update tokens in database
    const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000)
    await GoogleAdsIntegrationModel.updateOne(
      { _id: integration._id },
      {
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token || integration.refreshToken,
        expiresAt
      }
    )
    
    return newTokens.access_token
  }
  
  return integration.accessToken
}

export const fetchGoogleAdsLeadForms = async (userId: string): Promise<GoogleAdsLeadForm[]> => {
  const accessToken = await getValidGoogleAdsToken(userId)
  if (!accessToken) throw new Error('No valid Google Ads token')
  
  try {
    // Get accessible customers first
    const customersResponse = await axios.post(
      `https://googleads.googleapis.com/v17/customers:listAccessibleCustomers`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': googleAdsConfig.developerToken
        }
      }
    )
    
    const customers = customersResponse.data.resourceNames || []
    const allForms: GoogleAdsLeadForm[] = []
    
    for (const customer of customers) {
      const customerId = customer.split('/')[1]
      
      // Search for lead form extensions
      const searchResponse = await axios.post(
        `https://googleads.googleapis.com/v17/customers/${customerId}:search`,
        {
          query: `
            SELECT lead_form.id, 
                   lead_form.name, 
                   lead_form.status,
                   lead_form.fields,
                   campaign.id,
                   campaign.name,
                   ad_group.id,
                   ad_group.name
            FROM lead_form
            WHERE lead_form.status = 'ENABLED'
          `
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'developer-token': googleAdsConfig.developerToken
          }
        }
      )
      
      const forms = searchResponse.data.results || []
      allForms.push(...forms.map((result: any) => ({
        id: result.leadForm.id,
        name: result.leadForm.name,
        status: result.leadForm.status,
        fields: result.leadForm.fields || [],
        campaignId: result.campaign?.id || '',
        campaignName: result.campaign?.name || '',
        adGroupId: result.adGroup?.id || '',
        adGroupName: result.adGroup?.name || ''
      })))
    }
    
    return allForms
  } catch (err) {
    logger.error('Google Ads lead forms fetch error', err)
    throw err
  }
}

export const fetchGoogleAdsLeads = async (userId: string, formId?: string): Promise<GoogleAdsLead[]> => {
  const accessToken = await getValidGoogleAdsToken(userId)
  if (!accessToken) throw new Error('No valid Google Ads token')
  
  try {
    const integration = await getGoogleAdsIntegration(userId)
    if (!integration) throw new Error('No Google Ads integration found')
    
    const customerId = integration.customerId
    
    // Search for lead form submissions
    const query = formId
      ? `SELECT lead_form_submission.id,
              lead_form_submission.lead_form_id,
              lead_form_submission.campaign_id,
              lead_form_submission.ad_group_id,
              lead_form_submission.submitted_at,
              lead_form_submission.custom_lead_field_values,
              lead_form_submission.gclid
       FROM lead_form_submission
       WHERE lead_form_submission.lead_form_id = '${formId}'
         AND lead_form_submission.submitted_at DURING LAST_30_DAYS`
      : `SELECT lead_form_submission.id,
              lead_form_submission.lead_form_id,
              lead_form_submission.campaign_id,
              lead_form_submission.ad_group_id,
              lead_form_submission.submitted_at,
              lead_form_submission.custom_lead_field_values,
              lead_form_submission.gclid
       FROM lead_form_submission
       WHERE lead_form_submission.submitted_at DURING LAST_30_DAYS`
    
    const searchResponse = await axios.post(
      `https://googleads.googleapis.com/v17/customers/${customerId}:search`,
      { query },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': googleAdsConfig.developerToken
        }
      }
    )
    
    const submissions = searchResponse.data.results || []
    
    return submissions.map((result: any) => {
      const submission = result.leadFormSubmission
      const fields: { [key: string]: string } = {}
      
      // Parse custom field values
      if (submission.customLeadFieldValues) {
        for (const field of submission.customLeadFieldValues) {
          fields[field.leadFormFieldId] = field.stringValue || ''
        }
      }
      
      return {
        id: submission.id,
        formId: submission.leadFormId,
        campaignId: submission.campaignId,
        adGroupId: submission.adGroupId,
        submittedAt: new Date(submission.submittedAt),
        fields,
        gclid: submission.gclid
      }
    })
  } catch (err) {
    logger.error('Google Ads leads fetch error', err)
    throw err
  }
}
