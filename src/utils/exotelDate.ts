const EXOTEL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/

const EXOTEL_OFFSET_MINUTES = 5 * 60 + 30
const EXOTEL_OFFSET_MS = EXOTEL_OFFSET_MINUTES * 60 * 1000
const EXPLICIT_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i

const padMilliseconds = (value?: string) => String(value || '0').padEnd(3, '0').slice(0, 3)

const toExotelWallClockDate = (value: Date) => new Date(value.getTime() + EXOTEL_OFFSET_MS)

export const formatExotelDate = (value: Date): string => {
  const wallClock = toExotelWallClockDate(value)
  const year = wallClock.getUTCFullYear()
  const month = String(wallClock.getUTCMonth() + 1).padStart(2, '0')
  const day = String(wallClock.getUTCDate()).padStart(2, '0')
  const hours = String(wallClock.getUTCHours()).padStart(2, '0')
  const minutes = String(wallClock.getUTCMinutes()).padStart(2, '0')
  const seconds = String(wallClock.getUTCSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

export const parseExotelDate = (value?: string | Date | number | null): Date | null => {
  if (value === undefined || value === null || value === '') return null

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === 'number') {
    const parsedFromNumber = new Date(value)
    return Number.isNaN(parsedFromNumber.getTime()) ? null : parsedFromNumber
  }

  const raw = String(value).trim()
  if (!raw) return null

  if (EXPLICIT_TIMEZONE_PATTERN.test(raw)) {
    const parsedWithOffset = new Date(raw)
    return Number.isNaN(parsedWithOffset.getTime()) ? null : parsedWithOffset
  }

  const exactMatch = raw.match(EXOTEL_DATE_TIME_PATTERN)
  if (exactMatch) {
    const [, year, month, day, hours = '00', minutes = '00', seconds = '00', milliseconds = '000'] = exactMatch
    const parsedUtcMs =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds),
        Number(padMilliseconds(milliseconds))
      ) - EXOTEL_OFFSET_MS

    const parsedExotelTime = new Date(parsedUtcMs)
    return Number.isNaN(parsedExotelTime.getTime()) ? null : parsedExotelTime
  }

  const normalized = raw.includes(' ') && !raw.includes('T')
    ? raw.replace(' ', 'T')
    : raw

  const parsed = new Date(normalized)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed
  }

  const normalizedNaiveMatch = normalized.match(EXOTEL_DATE_TIME_PATTERN)
  if (normalizedNaiveMatch) {
    const [, year, month, day, hours = '00', minutes = '00', seconds = '00', milliseconds = '000'] = normalizedNaiveMatch
    const parsedUtcMs =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds),
        Number(padMilliseconds(milliseconds))
      ) - EXOTEL_OFFSET_MS

    const parsedExotelTime = new Date(parsedUtcMs)
    return Number.isNaN(parsedExotelTime.getTime()) ? null : parsedExotelTime
  }

  return null
}
