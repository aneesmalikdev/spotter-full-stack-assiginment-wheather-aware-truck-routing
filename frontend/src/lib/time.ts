/** Departure input and time display. Times are entered and shown in the browser's time zone; the
 * API gets ISO 8601 with the offset that applies at that moment (README "Assumptions" 21). */

const HOUR_MS = 3_600_000
export const PAST_GRACE_MS = HOUR_MS
export const MAX_DAYS_AHEAD = 13

export const DEPARTURE_MESSAGES = {
  missing: 'Enter the departure date and time.',
  past: 'The departure time is in the past.',
  tooFar: `Choose a departure within the next ${MAX_DAYS_AHEAD} days, so the forecast covers the 48 hours after it.`,
}

/** A Date as the value of an <input type="datetime-local">: "2026-10-25T14:00", local time. */
export function toInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The next full hour, as the form's starting departure. */
export function defaultDeparture(now: Date): string {
  const next = new Date(now)
  next.setMinutes(60, 0, 0)
  return toInputValue(next)
}

/** A datetime-local value as a Date in the browser's time zone, or null if it isn't one. */
export function parseInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null
  const date = new Date(value) // a date-time without an offset is local time
  return Number.isNaN(date.getTime()) ? null : date
}

/** ISO 8601 with the local offset, e.g. "2026-10-25T14:00:00-05:00". */
export function toApiDeparture(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const local = `${toInputValue(date)}:${pad(date.getSeconds())}`
  return `${local}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/** What is wrong with the departure, or null; the server checks the same. */
export function departureProblem(value: string, now: Date): string | null {
  const date = parseInputValue(value)
  if (date === null) return DEPARTURE_MESSAGES.missing
  if (date.getTime() < now.getTime() - PAST_GRACE_MS) return DEPARTURE_MESSAGES.past
  if (date.getTime() > now.getTime() + MAX_DAYS_AHEAD * 24 * HOUR_MS) return DEPARTURE_MESSAGES.tooFar
  return null
}

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
})
const dayTimeFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
})
const spokenDayTimeFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
})
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

/** "Sun, Oct 25, 2:30 PM CDT" in the browser's time zone. */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso))
}

/** "Sun, 2:30 PM CDT" in the browser's time zone. */
export function formatDayTime(iso: string): string {
  return dayTimeFormat.format(new Date(iso))
}

/** "Sunday, 2:30 PM CDT" in the browser's time zone: the weekday in full, for screen readers. */
export function formatSpokenDayTime(iso: string): string {
  return spokenDayTimeFormat.format(new Date(iso))
}

const dateKeyFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' })

/** The hour that ends at `iso`, in the browser's time zone: "Sun, 1:00 – 2:00 PM CDT". Both ends are
 * written in full when the hour crosses midnight ("Sun, 11:00 PM CDT – Mon, 12:00 AM CDT") or a clock
 * change, where formatRange would show the repeated 1 AM hour as a single time. */
export function formatHourEnding(iso: string): string {
  const end = new Date(iso)
  const start = new Date(end.getTime() - HOUR_MS)
  const sameDay = dateKeyFormat.format(start) === dateKeyFormat.format(end)
  return sameDay && start.getTimezoneOffset() === end.getTimezoneOffset()
    ? dayTimeFormat.formatRange(start, end)
    : `${dayTimeFormat.format(start)}\u2009–\u2009${dayTimeFormat.format(end)}`
}

/** The browser's time-zone abbreviation at that moment, e.g. "CDT". */
export function zoneName(date: Date): string {
  return timeFormat.formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? ''
}
