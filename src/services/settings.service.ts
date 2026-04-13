import { Settings } from '../models/Settings'
import { User } from '../models/User'
import { hashPassword } from '../utils/hash'
import { sendWelcomeEmail } from './ses.service'
import { logger } from '../utils/logger'

export const getOrCreateSettings = async () => {
  let settings = await Settings.findOne()
  if (!settings) {
    settings = await Settings.create({})
    logger.info('Default settings created')
  }
  return settings
}

export const createTeamMember = async (data: {
  name: string
  email: string
  role: 'manager' | 'representative'
  phone?: string
  password: string
}) => {
  const existing = await User.findOne({ email: data.email.toLowerCase() })
  if (existing) throw new Error('Email already in use')

  const hashed = await hashPassword(data.password)

  const user = await User.create({
    name: data.name,
    email: data.email.toLowerCase(),
    password: hashed,
    role: data.role,
    phone: data.phone || null,
    isActive: true,
  })

  await sendWelcomeEmail(user.email, user.name, data.password).catch(() => null)

  return { user }
}
