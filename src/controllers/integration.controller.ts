import { Request, Response, NextFunction } from 'express'
import { Integration } from '../models/Integration'
import { getGoogleAdsAuthUrl, exchangeGoogleAdsCode, getGoogleAdsUserInfo, saveGoogleAdsIntegration, fetchGoogleAdsLeadForms, fetchGoogleAdsLeads } from '../services/googleAds.service'
import { getLinkedInAuthUrl, exchangeLinkedInCode, getLinkedInUserInfo, saveLinkedInIntegration, fetchLinkedInLeadGenForms, fetchLinkedInLeads } from '../services/linkedin.service'
import { fetchAndSubscribeAllPages } from '../services/meta.service'
import { Lead } from '../models/Lead'
import { emitToTeam } from '../config/socket'
import axios from 'axios'
import { notifyNewLeadCreated } from '../services/notification.service'
import { logger } from '../utils/logger'

export const getIntegrations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integrations = await Integration.find({}).select('-accessToken -refreshToken -appSecret')
    return res.status(200).json({ success: true, data: integrations })
  } catch (err) {
    next(err)
  }
}

export const getIntegrationById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await Integration.findById(req.params.id).select('-accessToken -refreshToken -appSecret')
    if (!integration) {
      return res.status(404).json({ success: false, message: 'Integration not found' })
    }
    return res.status(200).json({ success: true, data: integration })
  } catch (err) {
    next(err)
  }
}

export const disconnectIntegration = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await Integration.findByIdAndUpdate(
      req.params.id,
      {
        status: 'disconnected',
        accessToken: null,
        refreshToken: null,
        connectedAt: null,
      },
      { new: true }
    )

    if (!integration) {
      return res.status(404).json({ success: false, message: 'Integration not found' })
    }

    return res.status(200).json({ success: true, data: integration })
  } catch (err) {
    next(err)
  }
}

export const getMetaOAuthUrl = (_req: Request, res: Response) => {
  const { META_APP_ID, APP_BASE_URL } = process.env
  const redirectUri = `${APP_BASE_URL}/api/integrations/meta/callback`
  const scopes = 'leads_retrieval,pages_read_engagement,pages_manage_metadata,pages_show_list'

  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code`

  return res.status(200).json({ success: true, data: { url } })
}

export const handleMetaOAuthCallback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as Record<string, string>
    const { META_APP_ID, META_APP_SECRET, APP_BASE_URL } = process.env
    const redirectUri = `${APP_BASE_URL}/api/integrations/meta/callback`

    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: redirectUri, code },
    })

    const { access_token, expires_in } = tokenRes.data

    // Exchange short-lived token for long-lived token
    const longLivedTokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: access_token,
      },
    })

    const longLivedAccessToken = longLivedTokenRes.data.access_token
    const longLivedExpiresIn = longLivedTokenRes.data.expires_in

    const profileRes = await axios.get('https://graph.facebook.com/me', {
      params: { access_token: longLivedAccessToken, fields: 'id,name' },
    })

    await Integration.findOneAndUpdate(
      { provider: 'meta' },
      {
        provider: 'meta',
        status: 'connected',
        accessToken: longLivedAccessToken,
        externalAccountId: profileRes.data.id,
        externalAccountName: profileRes.data.name,
        tokenExpiresAt: longLivedExpiresIn ? new Date(Date.now() + longLivedExpiresIn * 1000) : null,
        connectedAt: new Date(),
        connectedBy: req.user!.id,
      },
      { upsert: true, new: true }
    )

    // Automatically subscribe to leads for all accessible pages
    try {
      const results = await fetchAndSubscribeAllPages(longLivedAccessToken)
      logger.info('Meta page subscriptions completed', { results })
    } catch (err) {
      logger.error('Failed to subscribe to Meta pages after OAuth', err)
    }

    return res.redirect(`${process.env.FRONTEND_URL}/integrations?connected=meta`)
  } catch (err) {
    next(err)
  }
}

export const subscribeMetaPages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integration = await Integration.findOne({ provider: 'meta', status: 'connected' }).select('+accessToken')
    if (!integration?.accessToken) {
      return res.status(400).json({ success: false, message: 'Meta integration not connected' })
    }

    const results = await fetchAndSubscribeAllPages(integration.accessToken)
    return res.status(200).json({ success: true, data: results })
  } catch (err) {
    next(err)
  }
}

export const getGoogleAdsOAuthUrl = (_req: Request, res: Response) => {
  const url = getGoogleAdsAuthUrl()
  return res.status(200).json({ success: true, data: { url } })
}

export const handleGoogleAdsOAuthCallback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as Record<string, string>
    
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=google_ads&message=no_code`)
    }

    // Exchange code for tokens
    const tokens = await exchangeGoogleAdsCode(code)
    if (!tokens) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=google_ads&message=token_exchange_failed`)
    }

    // Get user info
    const userInfo = await getGoogleAdsUserInfo(tokens.access_token)
    if (!userInfo) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=google_ads&message=user_info_failed`)
    }

    // For now, we'll use the login customer ID from env. In a real implementation,
    // you might want to let the user select which customer to connect
    const { googleAdsConfig } = await import('../config/googleAds')
    const customerId = googleAdsConfig.loginCustomerId
    const customerName = `Google Ads Customer ${customerId}`

    // Save integration
    await saveGoogleAdsIntegration(req.user!.id, tokens, userInfo, customerId, customerName)

    // Update the generic Integration model for UI consistency
    await Integration.findOneAndUpdate(
      { provider: 'google-ads' },
      {
        provider: 'google-ads',
        status: 'connected',
        externalAccountId: customerId,
        externalAccountName: customerName,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        connectedAt: new Date(),
        connectedBy: req.user!.id,
      },
      { upsert: true, new: true }
    )

    return res.redirect(`${process.env.FRONTEND_URL}/integrations?connected=google-ads`)
  } catch (err) {
    next(err)
  }
}

export const getLinkedInOAuthUrl = (_req: Request, res: Response) => {
  const url = getLinkedInAuthUrl()
  return res.status(200).json({ success: true, data: { url } })
}

export const handleLinkedInOAuthCallback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as Record<string, string>
    
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=linkedin&message=no_code`)
    }

    // Exchange code for tokens
    const tokens = await exchangeLinkedInCode(code)
    if (!tokens) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=linkedin&message=token_exchange_failed`)
    }

    // Get user info
    const userInfo = await getLinkedInUserInfo(tokens.access_token)
    if (!userInfo) {
      return res.redirect(`${process.env.FRONTEND_URL}/integrations?error=linkedin&message=user_info_failed`)
    }

    // Save integration
    await saveLinkedInIntegration(req.user!.id, tokens, userInfo)

    // Update the generic Integration model for UI consistency
    const firstName = userInfo.firstName.localized?.en || Object.values(userInfo.firstName.localized)[0] || ''
    const lastName = userInfo.lastName.localized?.en || Object.values(userInfo.lastName.localized)[0] || ''
    const fullName = `${firstName} ${lastName}`

    await Integration.findOneAndUpdate(
      { provider: 'linkedin' },
      {
        provider: 'linkedin',
        status: 'connected',
        externalAccountId: userInfo.id,
        externalAccountName: fullName,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        connectedAt: new Date(),
        connectedBy: req.user!.id,
      },
      { upsert: true, new: true }
    )

    return res.redirect(`${process.env.FRONTEND_URL}/integrations?connected=linkedin`)
  } catch (err) {
    next(err)
  }
}

export const getGoogleAdsLeadForms = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const forms = await fetchGoogleAdsLeadForms(req.user!.id)
    return res.status(200).json({ success: true, data: forms })
  } catch (err) {
    next(err)
  }
}

export const fetchGoogleAdsLeadsToCRM = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { formId } = req.query
    const leads = await fetchGoogleAdsLeads(req.user!.id, formId as string)
    
    let importedCount = 0
    
    for (const lead of leads) {
      // Check if lead already exists
      const existingLead = await Lead.findOne({ externalId: lead.id, source: 'Google ADS' })
      if (existingLead) continue
      
      // Extract name and email from fields
      let name = 'Unknown'
      let email = ''
      let phone = ''
      let city = ''
      
      // Map common field IDs
      const fieldMap: { [key: string]: string } = {
        'name': 'name',
        'email': 'email', 
        'phone': 'phone',
        'city': 'city'
      }
      
      for (const [fieldId, value] of Object.entries(lead.fields)) {
        if (fieldId.toLowerCase().includes('name') && !name) name = value
        else if (fieldId.toLowerCase().includes('email') && !email) email = value
        else if (fieldId.toLowerCase().includes('phone') && !phone) phone = value
        else if (fieldId.toLowerCase().includes('city') && !city) city = value
      }
      
      // Create lead
      const newLead = await Lead.create({
        name,
        email: email || null,
        phone: phone || null,
        city: city || 'Unknown',
        source: 'Google ADS',
        externalId: lead.id,
        campaignId: lead.campaignId,
        googleClickId: lead.gclid,
        lastActivity: new Date(),
        disposition: 'New',
        lastActivityNote: `Lead form submitted: ${lead.formId}`,
        isInQueue: false,
      })

      // Emit to team
      emitToTeam('all', 'lead:incoming', {
        lead: { id: newLead._id, name: newLead.name, phone: newLead.phone, city: newLead.city, source: newLead.source, owner: null },
      })

      void notifyNewLeadCreated(newLead).catch(() => null)
      
      importedCount++
    }
    
    return res.status(200).json({ 
      success: true, 
      data: { 
        totalLeads: leads.length,
        importedCount,
        skippedCount: leads.length - importedCount
      }
    })
  } catch (err) {
    next(err)
  }
}

export const getLinkedInLeadForms = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const forms = await fetchLinkedInLeadGenForms(req.user!.id)
    return res.status(200).json({ success: true, data: forms })
  } catch (err) {
    next(err)
  }
}

export const fetchLinkedInLeadsToCRM = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { formId } = req.query
    const leads = await fetchLinkedInLeads(req.user!.id, formId as string)
    
    let importedCount = 0
    
    for (const lead of leads) {
      // Check if lead already exists
      const existingLead = await Lead.findOne({ externalId: lead.id, source: 'LinkedIn' })
      if (existingLead) continue
      
      // Create lead
      const newLead = await Lead.create({
        name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Unknown',
        email: lead.email || null,
        phone: lead.phone || null,
        city: 'Unknown',
        source: 'LinkedIn',
        externalId: lead.id,
        campaignId: lead.campaignId,
        lastActivity: new Date(lead.submittedAt),
        disposition: 'New',
        lastActivityNote: `LinkedIn Lead Gen Form: ${lead.formId}`,
        company: lead.company || null,
        jobTitle: lead.jobTitle || null,
        isInQueue: false,
      })

      // Emit to team
      emitToTeam('all', 'lead:incoming', {
        lead: { id: newLead._id, name: newLead.name, phone: newLead.phone, city: newLead.city, source: newLead.source, owner: null },
      })

      void notifyNewLeadCreated(newLead).catch(() => null)
      
      importedCount++
    }
    
    return res.status(200).json({ 
      success: true, 
      data: { 
        totalLeads: leads.length,
        importedCount,
        skippedCount: leads.length - importedCount
      }
    })
  } catch (err) {
    next(err)
  }
}

export const getExotelNumbers = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { exotelConfig } = await import('../config/exotel')
    const response = await axios.get(`${exotelConfig.baseUrl}/IncomingPhoneNumbers.json`)
    const numbers = response.data?.IncomingPhoneNumbers || []

    return res.status(200).json({ success: true, data: numbers })
  } catch (err) {
    next(err)
  }
}
