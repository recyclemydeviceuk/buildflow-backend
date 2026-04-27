import 'dotenv/config'
import http from 'http'
import app from './app'
import connectDB from './config/db'
import { initSocket } from './config/socket'
import { initTimyWebSocketServer } from './services/timy/timyServer'
import { PORT } from './config/constants'
import { startReminderNotifier, stopReminderNotifier } from './jobs/reminderNotifier.job'
import { startCallSyncPoller, stopCallSyncPoller } from './jobs/callSyncPoller.job'
import { startTeamDigest, stopTeamDigest } from './jobs/teamDigest.job'
import { integrationSyncJob } from './jobs/integrationSync.job'

const httpServer = http.createServer(app)

initSocket(httpServer)
initTimyWebSocketServer(httpServer)

const start = async () => {
  await connectDB()

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT} [${process.env.NODE_ENV}]`)
  })

  startReminderNotifier()
  startCallSyncPoller()
  startTeamDigest()
}

const shutdown = () => {
  stopReminderNotifier()
  stopCallSyncPoller()
  stopTeamDigest()
  integrationSyncJob.stop()
  httpServer.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
