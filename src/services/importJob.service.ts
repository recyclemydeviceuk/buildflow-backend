import { ImportJob } from '../models/ImportJob'
import { Lead } from '../models/Lead'
import { QueueItem } from '../models/QueueItem'
import { parseCSV, parseXLSX, ParsedRow } from '../utils/csvParser'
import { logger } from '../utils/logger'

export const processImportJob = async (jobId: string): Promise<void> => {
  const job = await ImportJob.findOne({ jobId })
  if (!job) { logger.warn('ImportJob not found', { jobId }); return }

  job.status = 'processing'
  await job.save()

  try {
    const response = await fetch(job.fileUrl)
    const buffer = Buffer.from(await response.arrayBuffer())

    const isCSV = job.fileName.endsWith('.csv')
    const rows: ParsedRow[] = isCSV ? parseCSV(buffer) : parseXLSX(buffer)

    job.totalRows = rows.length
    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        if (!row.name || !row.phone) {
          skipped++
          errors.push(`Row ${i + 2}: missing name or phone`)
          continue
        }

        const lead = await Lead.create({
          name: row.name,
          phone: row.phone,
          email: row.email || null,
          city: row.city || 'Unknown',
          source: row.source || 'Manual',
          disposition: 'New',
          budget: row.budget || null,
          campaign: row.campaign || null,
          utmSource: row.utmSource || null,
          utmMedium: row.utmMedium || null,
          utmCampaign: row.utmCampaign || null,
          lastActivity: new Date(),
        })

        await QueueItem.create({
          leadId: lead._id,
          leadName: lead.name,
          phone: lead.phone,
          city: lead.city,
          source: lead.source,
          segment: 'Unassigned',
          status: 'waiting',
          urgency: 1,
        })

        await Lead.findByIdAndUpdate(lead._id, { isInQueue: true })
        imported++
      } catch (err) {
        skipped++
        errors.push(`Row ${i + 2}: ${(err as Error).message}`)
      }
    }

    job.status = 'completed'
    job.importedRows = imported
    job.skippedRows = skipped
    job.importErrors = errors.slice(0, 100)
    job.completedAt = new Date()
    await job.save()

    logger.info('ImportJob completed', { jobId, imported, skipped })
  } catch (err) {
    job.status = 'failed'
    job.importErrors = [(err as Error).message]
    await job.save()
    logger.error('ImportJob failed', { jobId, err })
  }
}
