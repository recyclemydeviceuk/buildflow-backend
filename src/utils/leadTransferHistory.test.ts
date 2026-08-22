import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getLeadOwnershipAction,
  normalizeLeadTransferLog,
} from './leadTransferHistory'

describe('lead ownership audit classification', () => {
  it('distinguishes assignment, transfer, and unassignment', () => {
    const ada = { owner: 'rep-1', ownerName: 'Ada' }
    const grace = { owner: 'rep-2', ownerName: 'Grace' }

    assert.equal(getLeadOwnershipAction({}, ada), 'lead.assigned')
    assert.equal(getLeadOwnershipAction(ada, grace), 'lead.transferred')
    assert.equal(getLeadOwnershipAction(grace, {}), 'lead.unassigned')
  })

  it('does not report a transfer when ownership did not change', () => {
    assert.equal(
      getLeadOwnershipAction(
        { owner: 'rep-1', ownerName: 'Ada', disposition: 'New' },
        { owner: 'rep-1', ownerName: 'Ada', disposition: 'Interested' }
      ),
      null
    )
  })
})

describe('lead transfer history normalization', () => {
  it('preserves who moved which lead and both owners', () => {
    const row = normalizeLeadTransferLog({
      _id: 'audit-1',
      actor: 'manager-1',
      actorName: 'Manager One',
      actorRole: 'manager',
      action: 'lead.transferred',
      entityId: 'lead-1',
      before: { name: 'Client One', phone: '9999999999', owner: 'rep-1', ownerName: 'Ada' },
      after: { name: 'Client One', phone: '9999999999', owner: 'rep-2', ownerName: 'Grace' },
      metadata: { transferSource: 'bulk' },
      createdAt: '2026-08-22T10:00:00.000Z',
    })

    assert.deepEqual(row, {
      id: 'audit-1',
      leadId: 'lead-1',
      leadName: 'Client One',
      leadPhone: '9999999999',
      performedBy: { id: 'manager-1', name: 'Manager One', role: 'manager' },
      from: { id: 'rep-1', name: 'Ada' },
      to: { id: 'rep-2', name: 'Grace' },
      type: 'transfer',
      source: 'bulk',
      action: 'lead.transferred',
      createdAt: '2026-08-22T10:00:00.000Z',
    })
  })

  it('filters legacy bulk updates that did not change the owner', () => {
    assert.equal(
      normalizeLeadTransferLog({
        action: 'lead.bulk_updated',
        before: { owner: 'rep-1', ownerName: 'Ada', city: 'Delhi' },
        after: { owner: 'rep-1', ownerName: 'Ada', city: 'Mumbai' },
      }),
      null
    )
  })

  it('recovers older queue assignments that were stored against the queue item', () => {
    const row = normalizeLeadTransferLog({
      _id: 'audit-queue-1',
      actor: 'manager-1',
      actorName: 'Manager One',
      actorRole: 'manager',
      action: 'queue.assigned',
      entity: 'QueueItem',
      entityId: 'queue-1',
      after: {
        leadId: 'lead-1',
        leadName: 'Client One',
        phone: '9999999999',
        assignedTo: 'rep-1',
        assignedToName: 'Ada',
      },
      createdAt: '2026-08-22T10:00:00.000Z',
    })

    assert.equal(row?.leadId, 'lead-1')
    assert.equal(row?.leadName, 'Client One')
    assert.deepEqual(row?.to, { id: 'rep-1', name: 'Ada' })
    assert.equal(row?.type, 'assignment')
    assert.equal(row?.source, 'queue')
  })
})
