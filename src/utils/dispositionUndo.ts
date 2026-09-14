import { DISPOSITIONS } from '../config/constants'

/** 'YYYY-MM' — the only shape accepted for Lead.expectedMonth. */
export const EXPECTED_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type UndoTarget = { to: string; source: 'history' | 'statusNotes' }

type UndoableLead = {
  disposition?: string | null
  dispositionHistory?: Array<{ from?: string | null }> | null
  statusNotes?: Array<{ status?: string | null }> | null
}

const isKnownDisposition = (value: unknown): value is string =>
  typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value)

/**
 * Where an "Undo" would take a lead. Prefers the explicit dispositionHistory
 * stack (the last change's `from`). Leads that pre-date the history log fall
 * back to their status notes: the most recent note whose status differs from
 * the current disposition is where they came from.
 * Returns null when there is nothing to undo to.
 */
export const resolveUndoTarget = (lead: UndoableLead): UndoTarget | null => {
  const current = String(lead.disposition || '')
  const history = Array.isArray(lead.dispositionHistory) ? lead.dispositionHistory : []
  const last = history[history.length - 1]
  if (last && isKnownDisposition(last.from) && last.from !== current) {
    return { to: last.from, source: 'history' }
  }
  const notes = Array.isArray(lead.statusNotes) ? lead.statusNotes : []
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const status = notes[i]?.status
    if (isKnownDisposition(status) && status !== current) {
      return { to: status, source: 'statusNotes' }
    }
  }
  return null
}
