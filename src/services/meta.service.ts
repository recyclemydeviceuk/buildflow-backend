import axios from 'axios'
import { logger } from '../utils/logger'
import { Integration } from '../models/Integration'

interface MetaPage {
  id: string
  name: string
  access_token: string
  tasks: string[]
}

export const subscribeToPageLeads = async (pageId: string, pageAccessToken: string) => {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { subscribed_fields: ['leadgen'] },
      { params: { access_token: pageAccessToken } }
    )
    return res.data
  } catch (err: any) {
    logger.error(`Failed to subscribe to page ${pageId}`, err.response?.data || err.message)
    throw err
  }
}

export const fetchAndSubscribeAllPages = async (userAccessToken: string) => {
  try {
    // 1. Fetch user's pages
    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: userAccessToken, fields: 'id,name,access_token,tasks' },
    })

    const pages: MetaPage[] = pagesRes.data.data || []
    const results = []

    for (const page of pages) {
      // Check if page has leads_retrieval or manage_metadata tasks
      // Usually if they granted permissions, we should be able to subscribe
      try {
        const subResult = await subscribeToPageLeads(page.id, page.access_token)
        results.push({ pageId: page.id, pageName: page.name, success: subResult.success })
        logger.info(`Successfully subscribed to Meta leads for page: ${page.name} (${page.id})`)
      } catch (err) {
        results.push({ pageId: page.id, pageName: page.name, success: false })
      }
    }

    return results
  } catch (err: any) {
    logger.error('Failed to fetch and subscribe Meta pages', err.response?.data || err.message)
    throw err
  }
}
