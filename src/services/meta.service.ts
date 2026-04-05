import axios from 'axios'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { logger } from '../utils/logger'
import { JWT_SECRET } from '../config/constants'

interface MetaOAuthStatePayload {
  provider: 'meta'
  userId: string
}

interface MetaPage {
  id: string
  name: string
  access_token: string
  tasks: string[]
}

export interface MetaLeadField {
  name: string
  values: string[]
}

export interface MetaLeadPayload {
  id: string
  created_time?: string
  ad_id?: string
  form_id?: string
  field_data: MetaLeadField[]
}

export interface MetaLeadForm {
  id: string
  name: string
  status?: string
  locale?: string
  pageId: string
  pageName: string
}

const GRAPH_API_BASE_URL = 'https://graph.facebook.com/v19.0'

const buildAppSecretProof = (accessToken: string, appSecret?: string | null) => {
  if (!appSecret) return undefined
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex')
}

const buildGraphParams = (
  accessToken: string,
  appSecret?: string | null,
  extraParams: Record<string, string | number | boolean | undefined> = {}
) => {
  const appsecret_proof = buildAppSecretProof(accessToken, appSecret)
  return {
    access_token: accessToken,
    ...(appsecret_proof ? { appsecret_proof } : {}),
    ...extraParams,
  }
}

export const createMetaOAuthState = (userId: string) =>
  jwt.sign({ provider: 'meta', userId }, JWT_SECRET, { expiresIn: '15m' })

export const verifyMetaOAuthState = (state: string): MetaOAuthStatePayload | null => {
  try {
    const decoded = jwt.verify(state, JWT_SECRET) as jwt.JwtPayload
    if (decoded.provider !== 'meta' || typeof decoded.userId !== 'string') {
      return null
    }

    return {
      provider: 'meta',
      userId: decoded.userId,
    }
  } catch {
    return null
  }
}

export const exchangeMetaCodeForToken = async (code: string, redirectUri: string) => {
  const { META_APP_ID, META_APP_SECRET } = process.env

  const shortLivedTokenRes = await axios.get(`${GRAPH_API_BASE_URL}/oauth/access_token`, {
    params: {
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
  })

  const shortLivedAccessToken = shortLivedTokenRes.data.access_token as string
  const shortLivedExpiresIn = shortLivedTokenRes.data.expires_in as number | undefined

  try {
    const longLivedTokenRes = await axios.get(`${GRAPH_API_BASE_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: shortLivedAccessToken,
      },
    })

    const accessToken = longLivedTokenRes.data.access_token as string
    const expiresIn = longLivedTokenRes.data.expires_in as number | undefined

    return {
      accessToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    }
  } catch (err: any) {
    logger.warn('Failed to exchange Meta token for long-lived token, using short-lived token instead', err.response?.data || err.message)
    return {
      accessToken: shortLivedAccessToken,
      expiresAt: shortLivedExpiresIn ? new Date(Date.now() + shortLivedExpiresIn * 1000) : null,
    }
  }
}

export const fetchMetaUserProfile = async (accessToken: string, appSecret?: string | null) => {
  const response = await axios.get(`${GRAPH_API_BASE_URL}/me`, {
    params: buildGraphParams(accessToken, appSecret, { fields: 'id,name' }),
  })

  return response.data as { id: string; name: string }
}

export const fetchMetaPages = async (userAccessToken: string, appSecret?: string | null): Promise<MetaPage[]> => {
  try {
    const pagesRes = await axios.get(`${GRAPH_API_BASE_URL}/me/accounts`, {
      params: buildGraphParams(userAccessToken, appSecret, { fields: 'id,name,access_token,tasks' }),
    })

    return pagesRes.data.data || []
  } catch (err: any) {
    logger.error('Failed to fetch Meta pages', err.response?.data || err.message)
    throw err
  }
}

export const subscribeToPageLeads = async (pageId: string, pageAccessToken: string, appSecret?: string | null) => {
  try {
    const res = await axios.post(
      `${GRAPH_API_BASE_URL}/${pageId}/subscribed_apps`,
      null,
      {
        params: buildGraphParams(pageAccessToken, appSecret, { subscribed_fields: 'leadgen' }),
      }
    )
    return res.data
  } catch (err: any) {
    logger.error(`Failed to subscribe to page ${pageId}`, err.response?.data || err.message)
    throw err
  }
}

export const fetchMetaLeadData = async (
  leadgenId: string,
  accessToken: string,
  appSecret?: string | null
): Promise<MetaLeadPayload> => {
  const res = await axios.get(`${GRAPH_API_BASE_URL}/${leadgenId}`, {
    params: buildGraphParams(accessToken, appSecret, { fields: 'id,field_data,created_time,ad_id,form_id' }),
  })

  return {
    id: res.data.id || leadgenId,
    created_time: res.data.created_time,
    ad_id: res.data.ad_id,
    form_id: res.data.form_id,
    field_data: res.data.field_data || [],
  }
}

export const fetchMetaLeadForms = async (
  userAccessToken: string,
  appSecret?: string | null
): Promise<{ pages: Pick<MetaPage, 'id' | 'name' | 'tasks'>[]; forms: MetaLeadForm[] }> => {
  const pages = await fetchMetaPages(userAccessToken, appSecret)
  const forms: MetaLeadForm[] = []

  for (const page of pages) {
    try {
      const formsRes = await axios.get(`${GRAPH_API_BASE_URL}/${page.id}/leadgen_forms`, {
        params: buildGraphParams(page.access_token, appSecret, { fields: 'id,name,status,locale' }),
      })

      const pageForms = (formsRes.data.data || []).map((form: any) => ({
        id: String(form.id),
        name: String(form.name || form.id),
        status: typeof form.status === 'string' ? form.status : undefined,
        locale: typeof form.locale === 'string' ? form.locale : undefined,
        pageId: page.id,
        pageName: page.name,
      }))

      forms.push(...pageForms)
    } catch (err: any) {
      logger.error(`Failed to fetch Meta lead forms for page ${page.id}`, err.response?.data || err.message)
    }
  }

  return {
    pages: pages.map(({ id, name, tasks }) => ({ id, name, tasks })),
    forms,
  }
}

const fetchMetaFormLeads = async (
  pageAccessToken: string,
  formId: string,
  appSecret?: string | null,
  since?: Date
): Promise<MetaLeadPayload[]> => {
  const leads: MetaLeadPayload[] = []
  let nextUrl: string | null = `${GRAPH_API_BASE_URL}/${formId}/leads`
  let params: Record<string, string | number | boolean | undefined> | undefined = buildGraphParams(pageAccessToken, appSecret, {
    fields: 'id,created_time,ad_id,form_id,field_data',
    limit: 100,
    since: since ? Math.floor(since.getTime() / 1000) : undefined,
  })

  while (nextUrl) {
    const response: any = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((lead: any) => ({
      id: String(lead.id),
      created_time: typeof lead.created_time === 'string' ? lead.created_time : undefined,
      ad_id: typeof lead.ad_id === 'string' ? lead.ad_id : undefined,
      form_id: typeof lead.form_id === 'string' ? lead.form_id : formId,
      field_data: Array.isArray(lead.field_data) ? lead.field_data : [],
    }))

    leads.push(...batch)
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return leads
}

export const fetchAllMetaLeads = async (
  userAccessToken: string,
  appSecret?: string | null,
  options: {
    formId?: string
    sinceDays?: number
  } = {}
) => {
  const pages = await fetchMetaPages(userAccessToken, appSecret)
  const forms: MetaLeadForm[] = []
  const leads: MetaLeadPayload[] = []
  const since = typeof options.sinceDays === 'number' ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000) : undefined

  for (const page of pages) {
    try {
      const formsRes = await axios.get(`${GRAPH_API_BASE_URL}/${page.id}/leadgen_forms`, {
        params: buildGraphParams(page.access_token, appSecret, { fields: 'id,name,status,locale' }),
      })

      const pageForms = (formsRes.data.data || []).map((form: any) => ({
        id: String(form.id),
        name: String(form.name || form.id),
        status: typeof form.status === 'string' ? form.status : undefined,
        locale: typeof form.locale === 'string' ? form.locale : undefined,
        pageId: page.id,
        pageName: page.name,
      })) as MetaLeadForm[]

      const selectedForms = options.formId ? pageForms.filter((form) => form.id === options.formId) : pageForms
      forms.push(...selectedForms)

      for (const form of selectedForms) {
        try {
          const formLeads = await fetchMetaFormLeads(page.access_token, form.id, appSecret, since)
          leads.push(...formLeads)
        } catch (err: any) {
          logger.error(`Failed to fetch Meta leads for form ${form.id}`, err.response?.data || err.message)
        }
      }
    } catch (err: any) {
      logger.error(`Failed to fetch Meta lead forms for page ${page.id}`, err.response?.data || err.message)
    }
  }

  return {
    pages: pages.map(({ id, name, tasks }) => ({ id, name, tasks })),
    forms,
    leads,
  }
}

export const fetchAndSubscribeAllPages = async (userAccessToken: string, appSecret?: string | null) => {
  try {
    const pages = await fetchMetaPages(userAccessToken, appSecret)

    const results = []

    for (const page of pages) {
      try {
        const subResult = await subscribeToPageLeads(page.id, page.access_token, appSecret)
        results.push({ pageId: page.id, pageName: page.name, success: Boolean(subResult.success), tasks: page.tasks || [] })
        logger.info(`Successfully subscribed to Meta leads for page: ${page.name} (${page.id})`)
      } catch (err) {
        results.push({ pageId: page.id, pageName: page.name, success: false, tasks: page.tasks || [] })
      }
    }

    return results
  } catch (err: any) {
    logger.error('Failed to fetch and subscribe Meta pages', err.response?.data || err.message)
    throw err
  }
}

export const verifyMetaWebhookSignature = (
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret?: string | null
) => {
  if (!appSecret) return true
  if (!rawBody || !signatureHeader) return false

  const expectedSignature = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  const actualSignature = signatureHeader.trim()

  return (
    expectedSignature.length === actualSignature.length &&
    crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(actualSignature))
  )
}
