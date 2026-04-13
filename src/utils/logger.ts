import { NODE_ENV } from '../config/constants'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

const timestamp = () => new Date().toISOString()

const log = (level: LogLevel, message: string, meta?: unknown) => {
  const entry: Record<string, unknown> = { timestamp: timestamp(), level, message }
  if (meta !== undefined) entry.meta = meta

  if (level === 'error') {
    console.error(JSON.stringify(entry))
  } else if (level === 'warn') {
    console.warn(JSON.stringify(entry))
  } else if (NODE_ENV !== 'test') {
    console.log(JSON.stringify(entry))
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => log('info', message, meta),
  warn: (message: string, meta?: unknown) => log('warn', message, meta),
  error: (message: string, meta?: unknown) => log('error', message, meta),
  debug: (message: string, meta?: unknown) => {
    if (NODE_ENV === 'development') log('debug', message, meta)
  },
}
