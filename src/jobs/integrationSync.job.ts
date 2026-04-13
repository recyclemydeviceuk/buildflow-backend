import cron from 'node-cron'
import { fetchGoogleAdsLeads, getGoogleAdsIntegration } from '../services/googleAds.service'
import { fetchLinkedInLeads, getLinkedInIntegration } from '../services/linkedin.service'
import { Lead } from '../models/Lead'
import { emitToTeam } from '../config/socket'
import { logger } from '../utils/logger'
import { notifyNewLeadCreated } from '../services/notification.service'

class IntegrationSyncJob {
  private isRunning = false

  constructor() {
    this.start()
  }

  private start() {
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
      if (this.isRunning) {
        logger.warn('Integration sync job already running, skipping')
        return
      }

      this.isRunning = true
      try {
        await this.syncGoogleAdsLeads()
        await this.syncLinkedInLeads()
      } catch (err) {
        logger.error('Integration sync job error', err)
      } finally {
        this.isRunning = false
      }
    })

    logger.info('Integration sync job scheduled (every 15 minutes)')
  }

  private async syncGoogleAdsLeads() {
    try {
      // Get all active Google Ads integrations
      const { GoogleAdsIntegrationModel } = await import('../models/GoogleAdsIntegration')
      const integrations = await GoogleAdsIntegrationModel.find({ isActive: true })

      for (const integration of integrations) {
        try {
          const leads = await fetchGoogleAdsLeads(integration.userId.toString())
          
          for (const lead of leads) {
            // Check if lead already exists
            const existingLead = await Lead.findOne({ externalId: lead.id, source: 'Google ADS' })
            if (existingLead) continue
            
            // Extract fields
            let name = 'Unknown'
            let email = ''
            let phone = ''
            let city = ''
            
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
              lastActivity: new Date(lead.submittedAt),
              disposition: 'New',
              lastActivityNote: `Auto-synced from Google Ads: ${lead.formId}`,
              isInQueue: false,
            })

            // Emit to team
            emitToTeam('all', 'lead:incoming', {
              lead: { id: newLead._id, name: newLead.name, phone: newLead.phone, city: newLead.city, source: newLead.source, owner: null },
            })

            void notifyNewLeadCreated(newLead).catch(() => null)
            
            logger.info('Google Ads lead auto-synced', { leadId: lead.id, name })
          }
        } catch (err) {
          logger.error(`Google Ads sync failed for user ${integration.userId}`, err)
        }
      }
    } catch (err) {
      logger.error('Google Ads sync error', err)
    }
  }

  private async syncLinkedInLeads() {
    try {
      // Get all active LinkedIn integrations
      const { LinkedInIntegrationModel } = await import('../models/LinkedInIntegration')
      const integrations = await LinkedInIntegrationModel.find({ isActive: true })

      for (const integration of integrations) {
        try {
          const leads = await fetchLinkedInLeads(integration.userId.toString())
          
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
              lastActivityNote: `Auto-synced from LinkedIn: ${lead.formId}`,
              company: lead.company || null,
              jobTitle: lead.jobTitle || null,
              isInQueue: false,
            })

            // Emit to team
            emitToTeam('all', 'lead:incoming', {
              lead: { id: newLead._id, name: newLead.name, phone: newLead.phone, city: newLead.city, source: newLead.source, owner: null },
            })

            void notifyNewLeadCreated(newLead).catch(() => null)
            
            logger.info('LinkedIn lead auto-synced', { leadId: lead.id, name: newLead.name })
          }
        } catch (err) {
          logger.error(`LinkedIn sync failed for user ${integration.userId}`, err)
        }
      }
    } catch (err) {
      logger.error('LinkedIn sync error', err)
    }
  }

  async stop() {
    logger.info('Integration sync job stopped')
  }
}

export const integrationSyncJob = new IntegrationSyncJob()
