import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EXPECTED_MONTH_RE, resolveUndoTarget } from './dispositionUndo'

describe('resolveUndoTarget', () => {
  it('uses the last history entry when present', () => {
    const dispositionHistory = [
      { from: 'New', to: 'Interested' },
      { from: 'Interested', to: 'Failed' },
    ]
    const target = resolveUndoTarget({
      disposition: 'Failed',
      dispositionHistory,
      statusNotes: [{ status: 'New' }, { status: 'Interested' }, { status: 'Failed' }],
    })
    assert.deepEqual(target, { to: 'Interested', source: 'history' })
  })

  it('falls back to status notes for leads without history', () => {
    const target = resolveUndoTarget({
      disposition: 'Future',
      dispositionHistory: [],
      statusNotes: [{ status: 'New' }, { status: 'Qualified' }, { status: 'Future' }, { status: 'Future' }],
    })
    assert.deepEqual(target, { to: 'Qualified', source: 'statusNotes' })
  })

  it('returns null when there is nothing to go back to', () => {
    assert.equal(resolveUndoTarget({ disposition: 'New', dispositionHistory: [], statusNotes: [] }), null)
    assert.equal(
      resolveUndoTarget({ disposition: 'New', statusNotes: [{ status: 'New' }, { status: 'New' }] }),
      null
    )
  })

  it('ignores history entries that point at the current status or unknown values', () => {
    const dispositionHistory = [{ from: 'Interested', to: 'Interested' }]
    const target = resolveUndoTarget({
      disposition: 'Interested',
      dispositionHistory,
      statusNotes: [{ status: 'Bogus' }, { status: 'Contacted/Open' }, { status: 'Interested' }],
    })
    assert.deepEqual(target, { to: 'Contacted/Open', source: 'statusNotes' })
  })
})

describe('EXPECTED_MONTH_RE', () => {
  it('accepts YYYY-MM and rejects everything else', () => {
    assert.ok(EXPECTED_MONTH_RE.test('2027-03'))
    assert.ok(EXPECTED_MONTH_RE.test('2026-12'))
    assert.ok(!EXPECTED_MONTH_RE.test('2027-13'))
    assert.ok(!EXPECTED_MONTH_RE.test('2027-3'))
    assert.ok(!EXPECTED_MONTH_RE.test('2027-03-01'))
    assert.ok(!EXPECTED_MONTH_RE.test('March 2027'))
  })
})
