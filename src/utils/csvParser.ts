import path from 'path'
import { parse } from 'csv-parse/sync'
import * as XLSX from 'xlsx'

export interface ParsedRow {
  name?: string
  phone?: string
  email?: string
  city?: string
  source?: string
  budget?: string
  campaign?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  [key: string]: string | undefined
}

export interface ParsedImportFile {
  headers: string[]
  rows: Record<string, string>[]
}

const normalizeHeader = (value: unknown): string =>
  String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()

const sanitizeRecords = (headers: string[], rows: unknown[][]): Record<string, string>[] =>
  rows
    .map((row) =>
      headers.reduce<Record<string, string>>((accumulator, header, index) => {
        accumulator[header] = String(row[index] ?? '').trim()
        return accumulator
      }, {})
    )
    .filter((row) => Object.values(row).some((value) => value !== ''))

export const parseImportFile = (buffer: Buffer, fileName: string): ParsedImportFile => {
  const extension = path.extname(fileName).toLowerCase()

  if (extension === '.xlsx' || extension === '.xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    })
    const headers = (matrix[0] || []).map(normalizeHeader).filter(Boolean)
    return {
      headers,
      rows: sanitizeRecords(headers, matrix.slice(1)),
    }
  }

  const matrix = parse(buffer, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as unknown[][]
  const headers = (matrix[0] || []).map(normalizeHeader).filter(Boolean)

  return {
    headers,
    rows: sanitizeRecords(headers, matrix.slice(1)),
  }
}

export const parseCSV = (buffer: Buffer): ParsedRow[] => normalizeRows(parseImportFile(buffer, 'import.csv').rows)

export const parseXLSX = (buffer: Buffer): ParsedRow[] => normalizeRows(parseImportFile(buffer, 'import.xlsx').rows)

const COLUMN_MAP: Record<string, keyof ParsedRow> = {
  name: 'name', 'full name': 'name', fullname: 'name',
  phone: 'phone', mobile: 'phone', contact: 'phone', 'phone number': 'phone',
  email: 'email', 'email address': 'email',
  city: 'city', location: 'city',
  source: 'source', 'lead source': 'source',
  budget: 'budget',
  campaign: 'campaign',
  utm_source: 'utmSource', utmsource: 'utmSource',
  utm_medium: 'utmMedium', utmmedium: 'utmMedium',
  utm_campaign: 'utmCampaign', utmcampaign: 'utmCampaign',
}

const normalizeRows = (records: Record<string, string>[]): ParsedRow[] =>
  records.map((row) => {
    const normalized: ParsedRow = {}
    for (const [key, value] of Object.entries(row)) {
      const mapped = COLUMN_MAP[key.toLowerCase().trim()]
      if (mapped) normalized[mapped] = String(value).trim() || undefined
      else normalized[key] = String(value).trim() || undefined
    }
    return normalized
  })
