import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildLeadRow,
  DEFAULT_EXPORT_FIELDS,
  EXPORTABLE_FIELDS,
  PRIOR_MILESTONE_PRESET_FIELDS,
  resolveExportFields,
  toCsv,
} from './leadExport'

describe('resolveExportFields', () => {
  it('keeps exactly one individually selected field', () => {
    assert.deepEqual(resolveExportFields(['phone']), { ok: true, fields: ['phone'] })
  })

  it('keeps exactly the selected subset in canonical CSV order', () => {
    assert.deepEqual(resolveExportFields(['updatedAt', 'name', 'city', 'name']), {
      ok: true,
      fields: ['name', 'city', 'updatedAt'],
    })
  })

  it('keeps every field when Select All sends every key', () => {
    const allFields = EXPORTABLE_FIELDS.map((field) => field.key)
    assert.deepEqual(resolveExportFields(allFields), { ok: true, fields: allFields })
  })

  it('uses defaults only when fields is omitted', () => {
    assert.deepEqual(resolveExportFields(undefined), {
      ok: true,
      fields: DEFAULT_EXPORT_FIELDS,
    })
    assert.deepEqual(resolveExportFields(undefined, { priorMilestoneOnly: true }), {
      ok: true,
      fields: PRIOR_MILESTONE_PRESET_FIELDS,
    })
  })

  it('rejects empty, null, non-array, and unknown selections', () => {
    for (const selection of [[], null, 'name', ['name', 'notAField']]) {
      assert.equal(resolveExportFields(selection).ok, false)
    }
  })
})

describe('lead CSV projection', () => {
  const lead = {
    name: 'Ada Lovelace',
    phone: '9999999999',
    email: 'ada@example.com',
    city: 'Bengaluru',
    notes: 'Asked for 30x40, east-facing',
    owner: { name: 'Grace Hopper' },
  }

  it('builds a row with no properties beyond the requested fields', () => {
    const row = buildLeadRow(lead, ['name', 'email'])
    assert.deepEqual(Object.keys(row), ['name', 'email'])
    assert.deepEqual(row, { name: 'Ada Lovelace', email: 'ada@example.com' })
  })

  it('renders one selected field as one CSV column', () => {
    const fields = ['phone']
    const csv = toCsv([buildLeadRow(lead, fields)], fields)
    assert.equal(csv, 'Phone\n9999999999')
  })

  it('renders only the requested subset and escapes CSV values', () => {
    const fields = ['name', 'notes', 'ownerName']
    const csv = toCsv([buildLeadRow(lead, fields)], fields)
    assert.equal(
      csv,
      'Name,Notes,Owner\nAda Lovelace,"Asked for 30x40, east-facing",Grace Hopper'
    )
  })
})
