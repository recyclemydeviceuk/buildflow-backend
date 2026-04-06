import axios, { type AxiosResponse } from 'axios'
import crypto from 'crypto'
import { logger } from '../utils/logger'

interface MetaPage {
  id: string
  name: string
  access_token: string
  tasks: string[]
}

export interface MetaPageSummary {
  id: string
  name: string
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
  campaign_id?: string
  campaign_name?: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
}

export interface MetaLeadForm {
  id: string
  name: string
  status?: string
  locale?: string
  pageId: string
  pageName: string
}

export interface MetaAdAccount {
  id: string
  accountId: string
  name: string
  accountStatus?: number
}

export interface MetaCampaign {
  id: string
  name: string
  status?: string
  effectiveStatus?: string
  adAccountId?: string
}

export interface MetaAdDetails {
  id: string
  name?: string
  campaignId?: string
  campaignName?: string
  adsetId?: string
  adsetName?: string
}

export interface MetaLeadSyncOptions {
  adAccountId?: string
  pageIds?: string[]
  formIds?: string[]
  campaignIds?: string[]
  since?: Date
  sinceDays?: number
}

const GRAPH_API_BASE_URL = 'https://graph.facebook.com/v19.0'

type GraphApiResponse = AxiosResponse<any>

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

const asNonEmptyStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

export const normalizeMetaAdAccountId = (adAccountId: string) =>
  adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`

const fetchMetaPages = async (userAccessToken: string, appSecret?: string | null): Promise<MetaPage[]> => {
  const pages: MetaPage[] = []
  let nextUrl: string | null = `${GRAPH_API_BASE_URL}/me/accounts`
  let params: Record<string, string | number | boolean | undefined> | undefined = buildGraphParams(userAccessToken, appSecret, {
    fields: 'id,name,access_token,tasks',
    limit: 100,
  })

  while (nextUrl) {
    const response: GraphApiResponse = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((page: any) => ({
      id: String(page.id),
      name: String(page.name || page.id),
      access_token: String(page.access_token || ''),
      tasks: Array.isArray(page.tasks) ? page.tasks.map((task: any) => String(task)) : [],
    })) as MetaPage[]

    pages.push(...batch.filter((page) => Boolean(page.access_token)))
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return pages
}

const fetchMetaFormsForPage = async (
  pageId: string,
  pageName: string,
  pageAccessToken: string,
  appSecret?: string | null
): Promise<MetaLeadForm[]> => {
  const forms: MetaLeadForm[] = []
  let nextUrl: string | null = `${GRAPH_API_BASE_URL}/${pageId}/leadgen_forms`
  let params: Record<string, string | number | boolean | undefined> | undefined = buildGraphParams(pageAccessToken, appSecret, {
    fields: 'id,name,status,locale',
    limit: 100,
  })

  while (nextUrl) {
    const response: GraphApiResponse = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((form: any) => ({
      id: String(form.id),
      name: String(form.name || form.id),
      status: typeof form.status === 'string' ? form.status : undefined,
      locale: typeof form.locale === 'string' ? form.locale : undefined,
      pageId,
      pageName,
    })) as MetaLeadForm[]

    forms.push(...batch)
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return forms
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
    const response: GraphApiResponse = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((lead: any) => ({
      id: String(lead.id),
      created_time: typeof lead.created_time === 'string' ? lead.created_time : undefined,
      ad_id: typeof lead.ad_id === 'string' ? lead.ad_id : undefined,
      form_id: typeof lead.form_id === 'string' ? lead.form_id : formId,
      field_data: Array.isArray(lead.field_data) ? lead.field_data : [],
    })) as MetaLeadPayload[]

    leads.push(...batch)
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return leads
}

export const fetchMetaAdAccounts = async (userAccessToken: string, appSecret?: string | null): Promise<MetaAdAccount[]> => {
  const accounts: MetaAdAccount[] = []
  let nextUrl: string | null = `${GRAPH_API_BASE_URL}/me/adaccounts`
  let params: Record<string, string | number | boolean | undefined> | undefined = buildGraphParams(userAccessToken, appSecret, {
    fields: 'id,account_id,name,account_status',
    limit: 100,
  })

  while (nextUrl) {
    const response: GraphApiResponse = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((account: any) => ({
      id: normalizeMetaAdAccountId(String(account.account_id || account.id || '')),
      accountId: String(account.account_id || account.id || ''),
      name: String(account.name || account.account_id || account.id),
      accountStatus: typeof account.account_status === 'number' ? account.account_status : undefined,
    })) as MetaAdAccount[]

    accounts.push(...batch.filter((account) => Boolean(account.id)))
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return accounts
}

export const fetchMetaCampaigns = async (
  userAccessToken: string,
  adAccountId: string,
  appSecret?: string | null
): Promise<MetaCampaign[]> => {
  const campaigns: MetaCampaign[] = []
  const normalizedAdAccountId = normalizeMetaAdAccountId(adAccountId)
  let nextUrl: string | null = `${GRAPH_API_BASE_URL}/${normalizedAdAccountId}/campaigns`
  let params: Record<string, string | number | boolean | undefined> | undefined = buildGraphParams(userAccessToken, appSecret, {
    fields: 'id,name,status,effective_status',
    limit: 100,
  })

  while (nextUrl) {
    const response: GraphApiResponse = await axios.get(nextUrl, { params })
    const batch = (response.data.data || []).map((campaign: any) => ({
      id: String(campaign.id),
      name: String(campaign.name || campaign.id),
      status: typeof campaign.status === 'string' ? campaign.status : undefined,
      effectiveStatus: typeof campaign.effective_status === 'string' ? campaign.effective_status : undefined,
      adAccountId: normalizedAdAccountId,
    })) as MetaCampaign[]

    campaigns.push(...batch)
    nextUrl = response.data.paging?.next || null
    params = undefined
  }

  return campaigns
}

const fetchMetaAdDetails = async (
  userAccessToken: string,
  adId: string,
  appSecret?: string | null
): Promise<MetaAdDetails | null> => {
  try {
    const response: GraphApiResponse = await axios.get(`${GRAPH_API_BASE_URL}/${adId}`, {
      params: buildGraphParams(userAccessToken, appSecret, { fields: 'id,name,campaign{id,name},campaign_id,adset{id,name}' }),
    })

    const campaignId =
      typeof response.data.campaign_id === 'string'
        ? response.data.campaign_id
        : typeof response.data.campaign?.id === 'string'
          ? response.data.campaign.id
          : undefined

    const campaignName =
      typeof response.data.campaign?.name === 'string'
        ? response.data.campaign.name
        : undefined

    const adsetId = typeof response.data.adset?.id === 'string' ? response.data.adset.id : undefined
    const adsetName = typeof response.data.adset?.name === 'string' ? response.data.adset.name : undefined

    return {
      id: String(response.data.id || adId),
      name: typeof response.data.name === 'string' ? response.data.name : undefined,
      campaignId,
      campaignName,
      adsetId,
      adsetName,
    }
  } catch (err: any) {
    logger.warn('Failed to fetch Meta ad details', { adId, error: err.response?.data || err.message })
    return null
  }
}

export const fetchMetaAdsDetails = async (
  userAccessToken: string,
  adIds: string[],
  appSecret?: string | null
): Promise<Map<string, MetaAdDetails>> => {
  const uniqueAdIds = Array.from(new Set(adIds.filter(Boolean)))
  const adDetailsMap = new Map<string, MetaAdDetails>()

  for (let index = 0; index < uniqueAdIds.length; index += 10) {
    const batch = uniqueAdIds.slice(index, index + 10)
    const results = await Promise.all(batch.map((adId) => fetchMetaAdDetails(userAccessToken, adId, appSecret)))

    for (const details of results) {
      if (details?.id) {
        adDetailsMap.set(details.id, details)
      }
    }
  }

  return adDetailsMap
}

export const fetchMetaLeadSyncContext = async (
  userAccessToken: string,
  appSecret?: string | null,
  options: { adAccountId?: string } = {}
) => {
  const [adAccounts, pages] = await Promise.all([
    fetchMetaAdAccounts(userAccessToken, appSecret),
    fetchMetaPages(userAccessToken, appSecret),
  ])

  const forms: MetaLeadForm[] = []
  for (const page of pages) {
    try {
      const pageForms = await fetchMetaFormsForPage(page.id, page.name, page.access_token, appSecret)
      forms.push(...pageForms)
    } catch (err: any) {
      logger.error(`Failed to fetch Meta lead forms for page ${page.id}`, err.response?.data || err.message)
    }
  }

  const resolvedAdAccountId = options.adAccountId ? normalizeMetaAdAccountId(options.adAccountId) : undefined
  const campaigns = resolvedAdAccountId ? await fetchMetaCampaigns(userAccessToken, resolvedAdAccountId, appSecret) : []

  return {
    adAccounts,
    campaigns,
    pages: pages.map(({ id, name, tasks }) => ({ id, name, tasks })),
    forms,
  }
}

export const fetchMetaLeadsForSync = async (
  userAccessToken: string,
  appSecret?: string | null,
  options: MetaLeadSyncOptions = {}
) => {
  const pageIds = new Set(asNonEmptyStringArray(options.pageIds))
  const formIds = new Set(asNonEmptyStringArray(options.formIds))
  const requestedCampaignIds = new Set(asNonEmptyStringArray(options.campaignIds))
  const since = options.since || (typeof options.sinceDays === 'number' ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000) : undefined)
  const resolvedAdAccountId = options.adAccountId ? normalizeMetaAdAccountId(options.adAccountId) : undefined

  const [adAccounts, pages, campaigns] = await Promise.all([
    fetchMetaAdAccounts(userAccessToken, appSecret),
    fetchMetaPages(userAccessToken, appSecret),
    resolvedAdAccountId ? fetchMetaCampaigns(userAccessToken, resolvedAdAccountId, appSecret) : Promise.resolve([] as MetaCampaign[]),
  ])

  const selectedPages = pageIds.size > 0 ? pages.filter((page) => pageIds.has(page.id)) : pages
  const forms: MetaLeadForm[] = []
  const leads: MetaLeadPayload[] = []

  for (const page of selectedPages) {
    try {
      const pageForms = await fetchMetaFormsForPage(page.id, page.name, page.access_token, appSecret)
      const selectedForms = formIds.size > 0 ? pageForms.filter((form) => formIds.has(form.id)) : pageForms
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

  const adDetailsMap = await fetchMetaAdsDetails(
    userAccessToken,
    leads.map((lead) => lead.ad_id || '').filter(Boolean),
    appSecret
  )

  const availableCampaigns = new Map<string, MetaCampaign>()
  for (const campaign of campaigns) {
    availableCampaigns.set(campaign.id, campaign)
  }

  const enrichedLeads = leads.map((lead) => {
    const adDetails = lead.ad_id ? adDetailsMap.get(lead.ad_id) : undefined
    const campaignId = lead.campaign_id || adDetails?.campaignId
    const campaignName = lead.campaign_name || adDetails?.campaignName

    if (campaignId && !availableCampaigns.has(campaignId)) {
      availableCampaigns.set(campaignId, {
        id: campaignId,
        name: campaignName || campaignId,
        adAccountId: resolvedAdAccountId,
      })
    }

    return {
      ...lead,
      campaign_id: campaignId,
      campaign_name: campaignName,
      ad_name: lead.ad_name || adDetails?.name,
      adset_id: lead.adset_id || adDetails?.adsetId,
      adset_name: lead.adset_name || adDetails?.adsetName,
    }
  })

  const allowedCampaignIds = new Set<string>()
  if (resolvedAdAccountId) {
    for (const campaign of campaigns) {
      allowedCampaignIds.add(campaign.id)
    }
  }
  if (requestedCampaignIds.size > 0) {
    if (resolvedAdAccountId) {
      for (const campaignId of Array.from(allowedCampaignIds)) {
        if (!requestedCampaignIds.has(campaignId)) {
          allowedCampaignIds.delete(campaignId)
        }
      }
    } else {
      for (const campaignId of requestedCampaignIds) {
        allowedCampaignIds.add(campaignId)
      }
    }
  }

  const shouldFilterByCampaign = Boolean(resolvedAdAccountId) || requestedCampaignIds.size > 0
  const filteredLeads = shouldFilterByCampaign
    ? enrichedLeads.filter((lead) => Boolean(lead.campaign_id) && allowedCampaignIds.has(lead.campaign_id!))
    : enrichedLeads

  return {
    adAccounts,
    campaigns: Array.from(availableCampaigns.values()),
    pages: selectedPages.map(({ id, name, tasks }) => ({ id, name, tasks })),
    forms,
    leads: filteredLeads,
  }
}
