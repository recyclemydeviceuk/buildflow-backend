/**
 * One-off migration for the Oct 2026 status rename. Dry run by default.
 *
 *   npx ts-node src/scripts/migrateMeetingStatuses.ts           # counts only
 *   npx ts-node src/scripts/migrateMeetingStatuses.ts --apply   # rewrites leads
 *
 * "Visit Done" / "Meeting Done" were replaced by
 *   - "Virtual Meeting Done"   — video call only, no sub-type
 *   - "In-Person Meeting Done" — meetingType Office Place / Client Place
 * Legacy mapping:
 *   Visit Done                               → In-Person Meeting Done
 *   Meeting Done + meetingType Client Place  → In-Person Meeting Done (Client Place)
 *   Meeting Done (VC / unset)                → Virtual Meeting Done
 * Current status, status notes and undo history on a lead all map the same way.
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import connectDB from '../config/db'
import { Lead } from '../models/Lead'
import {
  IN_PERSON_MEETING_DONE,
  LEGACY_MEETING_DONE,
  LEGACY_MEETING_STATUSES,
  LEGACY_VISIT_DONE,
  VIRTUAL_MEETING_DONE,
} from '../config/constants'

const legacyFilter = {
  $or: [
    { disposition: { $in: LEGACY_MEETING_STATUSES } },
    { 'statusNotes.status': { $in: LEGACY_MEETING_STATUSES } },
    { 'dispositionHistory.from': { $in: LEGACY_MEETING_STATUSES } },
    { 'dispositionHistory.to': { $in: LEGACY_MEETING_STATUSES } },
    { meetingType: 'VC' },
  ],
}

const mapStatus = (expr: string) => ({
  $switch: {
    branches: [
      { case: { $eq: [expr, LEGACY_VISIT_DONE] }, then: IN_PERSON_MEETING_DONE },
      {
        case: { $eq: [expr, LEGACY_MEETING_DONE] },
        then: {
          $cond: [{ $eq: ['$meetingType', 'Client Place'] }, IN_PERSON_MEETING_DONE, VIRTUAL_MEETING_DONE],
        },
      },
    ],
    default: expr,
  },
})

const pipeline = [
  {
    $set: {
      disposition: mapStatus('$disposition'),
      statusNotes: {
        $map: {
          input: { $ifNull: ['$statusNotes', []] },
          as: 'n',
          in: { $mergeObjects: ['$$n', { status: mapStatus('$$n.status') }] },
        },
      },
      dispositionHistory: {
        $map: {
          input: { $ifNull: ['$dispositionHistory', []] },
          as: 'h',
          in: { $mergeObjects: ['$$h', { from: mapStatus('$$h.from'), to: mapStatus('$$h.to') }] },
        },
      },
      // VC is now the Virtual Meeting Done status itself, so the sub-type goes.
      meetingType: { $cond: [{ $eq: ['$meetingType', 'VC'] }, null, '$meetingType'] },
    },
  },
]

const run = async () => {
  const apply = process.argv.includes('--apply')
  await connectDB()

  const [visitDone, meetingClient, meetingOther, affected] = await Promise.all([
    Lead.collection.countDocuments({ disposition: LEGACY_VISIT_DONE }),
    Lead.collection.countDocuments({ disposition: LEGACY_MEETING_DONE, meetingType: 'Client Place' }),
    Lead.collection.countDocuments({ disposition: LEGACY_MEETING_DONE, meetingType: { $ne: 'Client Place' } }),
    Lead.collection.countDocuments(legacyFilter),
  ])
  console.log(`Visit Done → ${IN_PERSON_MEETING_DONE}: ${visitDone}`)
  console.log(`Meeting Done (Client Place) → ${IN_PERSON_MEETING_DONE}: ${meetingClient}`)
  console.log(`Meeting Done (VC/unset) → ${VIRTUAL_MEETING_DONE}: ${meetingOther}`)
  console.log(`Leads with any legacy value (incl. notes/history): ${affected}`)

  if (!apply) {
    console.log('Dry run — re-run with --apply to rewrite these leads.')
  } else {
    // Raw collection: legacy values would fail Mongoose's enum cast, and
    // updatedAt should not move for a rename.
    const result = await Lead.collection.updateMany(legacyFilter, pipeline)
    console.log(`Updated ${result.modifiedCount} leads.`)
  }
  await mongoose.disconnect()
}

run().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect()
  process.exit(1)
})
