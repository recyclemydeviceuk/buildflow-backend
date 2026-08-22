import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Lead } from '../models/Lead'
import { EXPORTABLE_FIELDS } from '../utils/leadExport'
import { exportLeads } from './lead.controller'

const originalFind = Lead.find

afterEach(() => {
  Lead.find = originalFind
})

const mockLeadQuery = (leads: Record<string, unknown>[]) => {
  Lead.find = (() => ({
    populate: () => ({
      sort: () => ({
        lean: async () => leads,
      }),
    }),
  })) as unknown as typeof Lead.find
}

const invokeExport = async (fields: unknown) => {
  let statusCode = 0
  let body: unknown
  const headers: Record<string, string> = {}
  let nextError: unknown

  const req = {
    user: { id: 'manager-id', name: 'Manager', role: 'manager' },
    body: { dateRange: 'lifetime', format: 'csv', fields },
  } as any

  const res = {
    status(code: number) {
      statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      headers[name] = value
      return this
    },
    send(value: unknown) {
      body = value
      return this
    },
    json(value: unknown) {
      body = value
      return this
    },
  } as any

  await exportLeads(req, res, (error?: unknown) => {
    nextError = error
  })

  assert.equal(nextError, undefined)
  return { statusCode, headers, body }
}

describe('POST /leads/export field selection', () => {
  it('returns a one-column CSV for one individually selected field', async () => {
    mockLeadQuery([{ name: 'Ada Lovelace', phone: '9999999999', city: 'Bengaluru' }])

    const response = await invokeExport(['phone'])

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['Content-Type'], 'text/csv')
    assert.equal(response.body, 'Phone\n9999999999')
  })

  it('returns exactly an arbitrary selected subset', async () => {
    mockLeadQuery([{ name: 'Ada Lovelace', phone: '9999999999', city: 'Bengaluru' }])

    const response = await invokeExport(['city', 'name'])

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, 'Name,City\nAda Lovelace,Bengaluru')
  })

  it('returns every available column when every field is selected', async () => {
    mockLeadQuery([{ name: 'Ada Lovelace', phone: '9999999999', city: 'Bengaluru' }])
    const allFields = EXPORTABLE_FIELDS.map((field) => field.key)

    const response = await invokeExport(allFields)

    assert.equal(response.statusCode, 200)
    const header = String(response.body).split('\n', 1)[0].split(',')
    assert.equal(header.length, allFields.length)
    assert.equal(header[0], 'Name')
    assert.equal(header[header.length - 1], 'Failed Note')
  })

  it('rejects an empty selection instead of expanding it to all columns', async () => {
    mockLeadQuery([{ name: 'Ada Lovelace', phone: '9999999999', city: 'Bengaluru' }])

    const response = await invokeExport([])

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.body, {
      success: false,
      message: 'Select at least one field to export',
    })
  })
})
