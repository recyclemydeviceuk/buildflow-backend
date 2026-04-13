import { addMinutes, addHours, addDays, isBefore, isAfter, differenceInMinutes, format } from 'date-fns'

export const isOverdue = (date: Date): boolean => isBefore(date, new Date())

export const isDueSoon = (date: Date, withinMinutes = 30): boolean => {
  const now = new Date()
  return isAfter(date, now) && isBefore(date, addMinutes(now, withinMinutes))
}

export const addOfferTimeout = (seconds: number): Date =>
  addSeconds(new Date(), seconds)

const addSeconds = (date: Date, secs: number): Date =>
  new Date(date.getTime() + secs * 1000)

export const startOfDay = (date: Date): Date => {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export const endOfDay = (date: Date): Date => {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

export const formatDate = (date: Date, fmt = 'yyyy-MM-dd'): string =>
  format(date, fmt)

export const msToSeconds = (ms: number): number => Math.floor(ms / 1000)

export const diffMinutes = (a: Date, b: Date): number =>
  differenceInMinutes(a, b)

export { addMinutes, addHours, addDays, isBefore, isAfter }
