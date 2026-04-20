/**
 * Seed / upsert the BuildFlow demo manager account.
 *
 * Run against whichever database the current MONGODB_URI points at:
 *
 *   npm run seed:demo
 *
 * Idempotent — running it multiple times is safe. It will:
 *   • create the demo account if it doesn't exist
 *   • or update the existing one's password + isDemo flag + role to manager
 *
 * Credentials (as requested by the product owner):
 *   email:    demo@gmail.com
 *   password: Demo@771922//!
 */

import 'dotenv/config'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { User } from '../models/User'
import { BCRYPT_SALT_ROUNDS } from '../config/constants'

const DEMO_EMAIL = 'demo@gmail.com'
const DEMO_PASSWORD = 'Demo@771922//!'
const DEMO_NAME = 'Demo Manager'

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('MONGODB_URI is not set in the environment.')
    process.exit(1)
  }

  await mongoose.connect(uri)
  console.log(`→ connected to: ${mongoose.connection.db?.databaseName || '(unknown)'}`)

  const hashed = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_SALT_ROUNDS)

  const existing = await User.findOne({ email: DEMO_EMAIL })
  if (existing) {
    existing.password = hashed
    existing.role = 'manager'
    existing.isActive = true
    existing.isDemo = true
    existing.name = existing.name || DEMO_NAME
    await existing.save()
    console.log(`✓ updated existing demo user ${DEMO_EMAIL} (id=${existing._id})`)
  } else {
    const created = await User.create({
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      password: hashed,
      role: 'manager',
      isActive: true,
      isDemo: true,
    })
    console.log(`✓ created new demo user ${DEMO_EMAIL} (id=${created._id})`)
  }

  console.log('\nDemo credentials:')
  console.log(`  email:    ${DEMO_EMAIL}`)
  console.log(`  password: ${DEMO_PASSWORD}`)
  console.log('\nThis account is view-only — all non-GET requests are blocked by the auth middleware.')

  await mongoose.disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
