import axios from 'axios'
import { linkedinConfig } from '../config/linkedin'
import { LinkedInOAuthTokenResponse, LinkedInUserInfo, LinkedInLeadGenForm, LinkedInLeadGenResponse } from '../types/linkedin.types'
import { LinkedInIntegrationModel } from '../models/LinkedInIntegration'
import { logger } from '../utils/logger'

export const getLinkedInAuthUrl = (): string => {
  return linkedinConfig.authUrl
}

export const exchangeLinkedInCode = async (code: string): Promise<LinkedInOAuthTokenResponse | null> => {
  try {
    const response = await axios.post<LinkedInOAuthTokenResponse>(
      linkedinConfig.tokenUrl,
      new URLSearchParams({
        code,
        client_id: linkedinConfig.clientId,
        client_secret: linkedinConfig.clientSecret,
        redirect_uri: linkedinConfig.redirectUri,
        grant_type: 'authorization_code'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    return response.data
  } catch (err) {
    logger.error('LinkedIn token exchange error', err)
    return null
  }
}

export const getLinkedInUserInfo = async (accessToken: string): Promise<LinkedInUserInfo | null> => {
  try {
    const response = await axios.get(linkedinConfig.userInfoUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    })
    return response.data
  } catch (err) {
    logger.error('LinkedIn user info error', err)
    return null
  }
}

export const refreshLinkedInToken = async (refreshToken: string): Promise<LinkedInOAuthTokenResponse | null> => {
  try {
    const response = await axios.post<LinkedInOAuthTokenResponse>(
      linkedinConfig.tokenUrl,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: linkedinConfig.clientId,
        client_secret: linkedinConfig.clientSecret,
        grant_type: 'refresh_token'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    return response.data
  } catch (err) {
    logger.error('LinkedIn token refresh error', err)
    return null
  }
}

export const saveLinkedInIntegration = async (
  userId: string,
  tokens: LinkedInOAuthTokenResponse,
  userInfo: LinkedInUserInfo
): Promise<void> => {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  const firstName = userInfo.firstName.localized?.en || Object.values(userInfo.firstName.localized)[0] || ''
  const lastName = userInfo.lastName.localized?.en || Object.values(userInfo.lastName.localized)[0] || ''
  
  await LinkedInIntegrationModel.findOneAndUpdate(
    { userId },
    {
      userId,
      personId: userInfo.id,
      firstName,
      lastName,
      email: userInfo.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      isActive: true
    },
    { upsert: true, new: true }
  )
}

export const getLinkedInIntegration = async (userId: string) => {
  return LinkedInIntegrationModel.findOne({ userId, isActive: true })
}

export const getValidLinkedInToken = async (userId: string): Promise<string | null> => {
  const integration = await getLinkedInIntegration(userId)
  if (!integration) return null
  
  // Check if token is expired
  if (integration.expiresAt <= new Date()) {
    if (!integration.refreshToken) return null
    
    const newTokens = await refreshLinkedInToken(integration.refreshToken)
    if (!newTokens) return null
    
    // Update tokens in database
    const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000)
    await LinkedInIntegrationModel.updateOne(
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

export const fetchLinkedInLeadGenForms = async (userId: string): Promise<LinkedInLeadGenForm[]> => {
  const accessToken = await getValidLinkedInToken(userId)
  if (!accessToken) throw new Error('No valid LinkedIn token')
  
  try {
    // Get all lead gen forms
    const response = await axios.get(
      `${linkedinConfig.apiBaseUrl}/leadGenForms`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        params: {
          q: 'criteria',
          fields: 'id,name,language,country,fields,creationTime,lastModifiedTime'
        }
      }
    )
    
    return response.data.elements || []
  } catch (err) {
    logger.error('LinkedIn lead gen forms fetch error', err)
    throw err
  }
}

export const fetchLinkedInLeads = async (userId: string, formId?: string): Promise<LinkedInLeadGenResponse[]> => {
  const accessToken = await getValidLinkedInToken(userId)
  if (!accessToken) throw new Error('No valid LinkedIn token')
  
  try {
    // First get the form IDs if not specified
    let formIds: string[] = []
    if (formId) {
      formIds = [formId]
    } else {
      const forms = await fetchLinkedInLeadGenForms(userId)
      formIds = forms.map(form => form.id)
    }
    
    const allLeads: LinkedInLeadGenResponse[] = []
    
    // Fetch leads for each form
    for (const fid of formIds) {
      const response = await axios.get(
        `${linkedinConfig.apiBaseUrl}/leadGenFormResponses`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          },
          params: {
            q: 'criteria',
            leadGenFormId: fid,
            fields: 'id,formId,submittedAt,memberId,firstName,lastName,email,company,jobTitle,phone,customAnswers,campaignId,adId'
          }
        }
      )
      
      const leads = response.data.elements || []
      allLeads.push(...leads)
    }
    
    // Filter leads from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    return allLeads.filter(lead => new Date(lead.submittedAt) >= thirtyDaysAgo)
  } catch (err) {
    logger.error('LinkedIn leads fetch error', err)
    throw err
  }
}
