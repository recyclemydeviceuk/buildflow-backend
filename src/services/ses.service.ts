import fs from 'fs'
import path from 'path'
import { SendEmailCommand } from '@aws-sdk/client-ses'
import { sesClient, SES_FROM_EMAIL, SES_FROM_NAME } from '../config/aws'
import { FRONTEND_URL } from '../config/constants'
import { logger } from '../utils/logger'

const TEMPLATES_DIR = path.join(__dirname, '..', 'emails', 'templates')

const loadTemplate = (name: string, vars: Record<string, string>): string => {
  const filePath = path.join(TEMPLATES_DIR, `${name}.html`)
  let html = fs.readFileSync(filePath, 'utf-8')
  for (const [key, value] of Object.entries(vars)) {
    html = html.split(`{{${key}}}`).join(value)
  }
  return html
}

interface SendEmailOptions {
  to: string | string[]
  subject: string
  html: string
}

export const sendEmail = async (opts: SendEmailOptions): Promise<boolean> => {
  try {
    const toAddresses = Array.isArray(opts.to) ? opts.to : [opts.to]

    await sesClient.send(
      new SendEmailCommand({
        Source: `${SES_FROM_NAME} <${SES_FROM_EMAIL}>`,
        Destination: { ToAddresses: toAddresses },
        Message: {
          Subject: { Data: opts.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: opts.html, Charset: 'UTF-8' } },
        },
      })
    )
    return true
  } catch (err) {
    logger.error('SES sendEmail error', err)
    return false
  }
}

export const sendWelcomeEmail = async (to: string, name: string, password: string): Promise<boolean> => {
  const html = loadTemplate('welcomeEmail', {
    name,
    email: to,
    password,
    loginUrl: `${FRONTEND_URL}/login`,
  })
  return sendEmail({ to, subject: 'Welcome to BuildFlow — Your Login Details', html })
}

export const sendPasswordResetEmail = async (to: string, resetUrl: string, name = ''): Promise<boolean> => {
  const html = loadTemplate('passwordReset', { name, resetUrl })
  return sendEmail({ to, subject: 'Reset Your BuildFlow Password', html })
}

export const sendReminderEmail = async (to: string, name: string, title: string, dueAt: Date): Promise<boolean> => {
  const html = loadTemplate('reminderAlert', {
    name,
    title,
    dueAt: dueAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
    leadUrl: `${FRONTEND_URL}/leads`,
  })
  return sendEmail({ to, subject: `Reminder: ${title}`, html })
}

export const sendLeadAssignedEmail = async (
  to: string,
  repName: string,
  leadName: string,
  phone: string,
  city: string,
  source: string,
  leadId: string
): Promise<boolean> => {
  const html = loadTemplate('leadAssigned', {
    repName,
    leadName,
    phone,
    city,
    source,
    leadUrl: `${FRONTEND_URL}/leads/${leadId}`,
  })
  return sendEmail({ to, subject: `Lead Assigned: ${leadName}`, html })
}

export const sendLoginNotificationEmail = async (
  to: string,
  name: string,
  loginAt: Date,
  ipAddress: string,
  userAgent: string
): Promise<boolean> => {
  const html = loadTemplate('loginNotification', {
    name,
    loginAt: loginAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
    ipAddress,
    userAgent,
  })
  return sendEmail({ to, subject: 'New Login to Your BuildFlow Account', html })
}

export const sendTeamDigestEmail = async (
  to: string,
  name: string,
  stats: { callsToday: number; connectedCalls: number; overdueReminders: number; newLeads: number }
): Promise<boolean> => {
  const html = loadTemplate('teamDigest', {
    name,
    callsToday: String(stats.callsToday),
    connectedCalls: String(stats.connectedCalls),
    overdueReminders: String(stats.overdueReminders),
    newLeads: String(stats.newLeads),
    dashboardUrl: `${FRONTEND_URL}/dashboard`,
  })
  return sendEmail({ to, subject: 'Your BuildFlow Daily Digest', html })
}

export const sendNewLeadAlertEmail = async (
  to: string,
  name: string,
  lead: {
    name: string
    phone: string
    city?: string | null
    source: string
    leadId: string
  }
): Promise<boolean> => {
  const html = loadTemplate('newLeadAlert', {
    name,
    leadName: lead.name,
    phone: lead.phone,
    city: lead.city || 'Unknown',
    source: lead.source,
    leadUrl: `${FRONTEND_URL}/leads/${lead.leadId}`,
  })

  return sendEmail({ to, subject: `New Lead Alert: ${lead.name}`, html })
}

export const sendMissedCallAlertEmail = async (
  to: string,
  name: string,
  payload: {
    leadName: string
    phone: string
    callDirection: string
    outcome: string
    callAt?: Date | null
    exophoneNumber?: string | null
    leadId?: string | null
  }
): Promise<boolean> => {
  const html = loadTemplate('missedCallAlert', {
    name,
    leadName: payload.leadName,
    phone: payload.phone,
    callDirection: payload.callDirection,
    outcome: payload.outcome,
    exophoneNumber: payload.exophoneNumber || 'N/A',
    callAt: payload.callAt
      ? payload.callAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : 'Just now',
    leadUrl: payload.leadId ? `${FRONTEND_URL}/leads/${payload.leadId}` : `${FRONTEND_URL}/call-log`,
  })

  return sendEmail({ to, subject: `Missed Call Alert: ${payload.leadName}`, html })
}
