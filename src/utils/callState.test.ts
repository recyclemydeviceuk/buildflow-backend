import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LIVE_CALL_STALE_MS,
  PRE_ANSWER_STALE_MS,
  isOpenCallStatus,
  isStaleOpenCall,
  resolveManagedCallState,
} from './callState'

describe('resolveManagedCallState', () => {
  it('maps terminal Exotel v3 statuses to closed local statuses', () => {
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: 'completed' }), {
      status: 'completed',
      outcome: 'Connected',
      terminal: true,
    })
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: 'to_leg_unanswered' }), {
      status: 'no-answer',
      outcome: 'Not Answered',
      terminal: true,
    })
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: 'from_leg_unanswered' }), {
      status: 'failed',
      outcome: 'Not Answered',
      terminal: true,
    })
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: 'from_leg_cancelled' }), {
      status: 'canceled',
      outcome: 'Not Answered',
      terminal: true,
    })
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: 'busy' }), {
      status: 'busy',
      outcome: 'Busy',
      terminal: true,
    })
  })

  it('closes a terminal call even when Exotel gives an unknown or missing status', () => {
    assert.deepEqual(resolveManagedCallState({ state: 'terminal', status: null }), {
      status: 'failed',
      outcome: null,
      terminal: true,
    })
    assert.equal(resolveManagedCallState({ state: 'terminal', status: 'something_new' })?.terminal, true)
  })

  it('keeps active calls open and leaves unknown active states alone', () => {
    assert.deepEqual(resolveManagedCallState({ state: 'active', status: 'in-progress' }), {
      status: 'in-progress',
      outcome: null,
      terminal: false,
    })
    assert.equal(resolveManagedCallState({ state: 'active', status: 'ringing' })?.status, 'ringing')
    assert.equal(resolveManagedCallState({ state: 'active', status: null }), null)
    assert.equal(resolveManagedCallState(null), null)
  })
})

describe('isStaleOpenCall', () => {
  const now = new Date('2026-09-30T08:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('treats a call still dialing well past the ring timeout as stale', () => {
    assert.equal(isStaleOpenCall({ status: 'initiated', startedAt: ago(PRE_ANSWER_STALE_MS + 1000) }, now), true)
    assert.equal(isStaleOpenCall({ status: 'ringing', startedAt: ago(2 * 60 * 60 * 1000) }, now), true)
    assert.equal(isStaleOpenCall({ status: 'initiated', startedAt: ago(60 * 1000) }, now), false)
  })

  it('allows live calls to run up to the Exotel max call length', () => {
    assert.equal(isStaleOpenCall({ status: 'in-progress', startedAt: ago(2 * 60 * 60 * 1000) }, now), false)
    assert.equal(isStaleOpenCall({ status: 'in-progress', startedAt: ago(LIVE_CALL_STALE_MS + 1000) }, now), true)
  })

  it('never flags closed calls and falls back to createdAt', () => {
    assert.equal(isStaleOpenCall({ status: 'completed', startedAt: ago(10 * 60 * 60 * 1000) }, now), false)
    assert.equal(isStaleOpenCall({ status: 'initiated', startedAt: null, createdAt: ago(PRE_ANSWER_STALE_MS + 1000) }, now), true)
    assert.equal(isStaleOpenCall({ status: 'initiated', startedAt: null, createdAt: null }, now), false)
  })
})

describe('isOpenCallStatus', () => {
  it('recognises only dialing and live statuses as open', () => {
    assert.equal(isOpenCallStatus('initiated'), true)
    assert.equal(isOpenCallStatus('in-progress'), true)
    assert.equal(isOpenCallStatus('no-answer'), false)
    assert.equal(isOpenCallStatus(null), false)
  })
})
