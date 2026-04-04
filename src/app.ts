import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { FRONTEND_URL, NODE_ENV } from './config/constants'
import { globalRateLimiter } from './middleware/rateLimiter.middleware'
import { errorHandler, notFound } from './middleware/errorHandler.middleware'

import authRoutes from './routes/auth.routes'
import leadRoutes from './routes/lead.routes'
import callRoutes from './routes/call.routes'
import reminderRoutes from './routes/reminder.routes'
import analyticsRoutes from './routes/analytics.routes'
import reportsRoutes from './routes/reports.routes'
import auditLogRoutes from './routes/auditLog.routes'
import settingsRoutes from './routes/settings.routes'
import uploadRoutes from './routes/upload.routes'
import webhookRoutes from './routes/webhook.routes'
import integrationRoutes from './routes/integration.routes'
import performanceRoutes from './routes/performance.routes'

const app = express()

app.use(helmet())
app.use(cors({ origin: FRONTEND_URL, credentials: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

if (NODE_ENV !== 'test') {
  app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'))
}

app.use(globalRateLimiter)

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }))

app.use('/api/auth', authRoutes)
app.use('/api/leads', leadRoutes)
app.use('/api/calls', callRoutes)
app.use('/api/reminders', reminderRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/reports', reportsRoutes)
app.use('/api/audit-logs', auditLogRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/webhooks', webhookRoutes)
app.use('/api/integrations', integrationRoutes)
app.use('/api/performance', performanceRoutes)

app.use(notFound)
app.use(errorHandler)

export default app
