import { describe, expect, it } from 'vitest'
import {
  DEPARTURE_MESSAGES,
  defaultDeparture,
  departureProblem,
  formatDateTime,
  formatDayTime,
  formatHourEnding,
  parseInputValue,
  toApiDeparture,
  toInputValue,
  zoneName,
} from './time'

// Tests run in America/Chicago (vite.config.ts). US daylight saving time ends on 2026-11-01.
const plain = (text: string) => text.replace(/ /g, ' ') // ICU puts a narrow space before AM/PM

describe('departure input', () => {
  it('sends local time with the offset in force at that moment', () => {
    expect(toApiDeparture(new Date('2026-10-25T14:00'))).toBe('2026-10-25T14:00:00-05:00')
    expect(toApiDeparture(new Date('2026-11-02T09:30'))).toBe('2026-11-02T09:30:00-06:00')
  })

  it('round-trips the input value', () => {
    const date = parseInputValue('2026-10-25T14:05')
    expect(date).not.toBeNull()
    expect(toInputValue(date!)).toBe('2026-10-25T14:05')
  })

  it.each(['', 'tomorrow', '2026-13-01T00:00', '2026-10-25'])('refuses %j', value => {
    expect(parseInputValue(value)).toBeNull()
  })

  it('starts at the next full hour', () => {
    expect(defaultDeparture(new Date('2026-10-24T22:07:30'))).toBe('2026-10-24T23:00')
    expect(defaultDeparture(new Date('2026-10-24T23:30:00'))).toBe('2026-10-25T00:00')
  })
})

describe('departure limits match the server', () => {
  const now = new Date('2026-10-24T12:00:00')

  it.each([
    ['', DEPARTURE_MESSAGES.missing],
    ['2026-10-24T10:59', DEPARTURE_MESSAGES.past],
    ['2026-10-24T11:00', null], // exactly one hour ago
    // Exactly 13 x 24 hours ahead is 11:00, not 12:00: the clocks go back an hour on November 1.
    ['2026-11-06T11:00', null],
    ['2026-11-06T11:01', DEPARTURE_MESSAGES.tooFar],
  ])('%j -> %j', (value, problem) => {
    expect(departureProblem(value, now)).toBe(problem)
  })
})

describe('time display', () => {
  it('shows the browser time zone', () => {
    expect(plain(formatDateTime('2026-10-25T19:30:00Z'))).toBe('Sun, Oct 25, 2:30 PM CDT')
    expect(plain(formatDayTime('2026-10-26T00:12:00Z'))).toBe('Sun, 7:12 PM CDT')
    expect(zoneName(new Date('2026-10-25T19:30:00Z'))).toBe('CDT')
    expect(zoneName(new Date('2026-11-02T15:00:00Z'))).toBe('CST') // after daylight saving time ends
  })

  it('shows the hour that ends at a time, both ends in full across midnight', () => {
    const spaced = (text: string) => plain(text).replace(/\u2009/g, ' ')
    expect(spaced(formatHourEnding('2026-10-25T19:00:00Z'))).toBe('Sun, 1:00 – 2:00 PM CDT')
    expect(spaced(formatHourEnding('2026-10-26T05:00:00Z'))).toBe('Sun, 11:00 PM CDT – Mon, 12:00 AM CDT')
    // Clocks going back repeat 1 AM, and going forward skip 2 AM: both ends in full, with their zones.
    expect(spaced(formatHourEnding('2026-11-01T07:00:00Z'))).toBe('Sun, 1:00 AM CDT – Sun, 1:00 AM CST')
    expect(spaced(formatHourEnding('2027-03-14T08:00:00Z'))).toBe('Sun, 1:00 AM CST – Sun, 3:00 AM CDT')
  })
})
