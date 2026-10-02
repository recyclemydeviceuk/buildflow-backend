export type LocalCallStatus =
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'no-answer'
  | 'busy'
  | 'canceled'

export const OPEN_CALL_STATUSES: LocalCallStatus[] = ['initiated', 'ringing', 'in-progress']

export const isOpenCallStatus = (status?: string | null): boolean =>
  OPEN_CALL_STATUSES.includes((status || '') as LocalCallStatus)

// Each leg rings for at most attempt_time_out (45s), so a call that is still
// "initiated"/"ringing" after this long never got its answered/terminal update.
export const PRE_ANSWER_STALE_MS = 20 * 60 * 1000
// Exotel hard-stops every call at max_time_limit (4h); allow a small buffer.
export const LIVE_CALL_STALE_MS = (4 * 60 + 15) * 60 * 1000

export interface ResolvedManagedCallState {
  status: LocalCallStatus
  outcome: string | null
  terminal: boolean
}

/**
 * Maps an Exotel v3 call-details snapshot (state + status) to the local call
 * status. Returns null when Exotel reports the call as active without a status
 * we can trust, so callers leave the current status untouched.
 */
export const resolveManagedCallState = (details?: {
  state?: string | null
  status?: string | null
} | null): ResolvedManagedCallState | null => {
  if (!details) return null

  const status = (details.status || '').toLowerCase()
  const state = (details.state || '').toLowerCase()

  switch (status) {
    case 'completed':
      return { status: 'completed', outcome: 'Connected', terminal: true }
    case 'busy':
      return { status: 'busy', outcome: 'Busy', terminal: true }
    case 'no-answer':
    case 'no_answer':
    case 'to_leg_unanswered':
      return { status: 'no-answer', outcome: 'Not Answered', terminal: true }
    case 'failed':
    case 'from_leg_unanswered':
    case 'from_leg_no_dial':
    case 'to_leg_no_dial':
      return { status: 'failed', outcome: 'Not Answered', terminal: true }
    case 'canceled':
    case 'cancelled':
    case 'from_leg_cancelled':
      return { status: 'canceled', outcome: 'Not Answered', terminal: true }
  }

  if (state === 'terminal') {
    return { status: 'failed', outcome: null, terminal: true }
  }

  switch (status) {
    case 'in-progress':
    case 'answered':
      return { status: 'in-progress', outcome: null, terminal: false }
    case 'ringing':
      return { status: 'ringing', outcome: null, terminal: false }
    case 'initiated':
    case 'queued':
      return { status: 'initiated', outcome: null, terminal: false }
    default:
      return null
  }
}

/** True when an open call is too old to still be dialing or live. */
export const isStaleOpenCall = (
  call: { status?: string | null; startedAt?: Date | string | null; createdAt?: Date | string | null },
  now: Date = new Date()
): boolean => {
  if (!isOpenCallStatus(call.status)) return false

  const startedRaw = call.startedAt || call.createdAt
  if (!startedRaw) return false
  const startedAt = new Date(startedRaw).getTime()
  if (Number.isNaN(startedAt)) return false

  const ageMs = now.getTime() - startedAt
  return ageMs > (call.status === 'in-progress' ? LIVE_CALL_STALE_MS : PRE_ANSWER_STALE_MS)
}
