import { describe, expect, it } from 'vitest'
import { type FormValues, parseLoad, toRequest, validate } from './form'

const NOW = new Date('2026-10-24T12:00:00') // America/Chicago (vite.config.ts)
const VALID: FormValues = {
  origin: ' Dallas, TX ',
  destination: 'Denver, CO',
  departure: '2026-10-25T14:00',
  load: '35,000',
  interval: 25,
}

describe('trip form', () => {
  it('accepts a complete form and builds the request', () => {
    expect(validate(VALID, NOW)).toEqual({})
    expect(toRequest(VALID)).toEqual({
      origin: 'Dallas, TX',
      destination: 'Denver, CO',
      departure: '2026-10-25T14:00:00-05:00',
      load_lb: 35000,
      interval_miles: 25,
    })
  })

  it('reports every problem with the server’s wording', () => {
    const errors = validate({ origin: '', destination: 'D', departure: '', load: 'heavy', interval: 25 }, NOW)
    expect(errors).toEqual({
      origin: 'Enter where the trip starts.',
      destination: 'Enter at least 2 characters.',
      departure: 'Enter the departure date and time.',
      load_lb: 'Enter the load weight in pounds.',
    })
  })

  it.each([
    ['-5', "The load weight can't be negative."],
    ['200001', 'The load weight must be at most 200,000 lb.'],
    ['', 'Enter the load weight in pounds.'],
    ['1e5', 'Enter the load weight in pounds.'],
  ])('checks the load %j', (load, message) => {
    expect(validate({ ...VALID, load }, NOW).load_lb).toBe(message)
  })

  it.each([
    ['35000', 35000],
    ['35,000', 35000],
    ['0', 0],
    ['200000', 200000],
    ['12.5', 12.5],
    ['', null],
    ['35k', null],
  ])('reads the load %j', (text, value) => {
    expect(parseLoad(text)).toBe(value)
  })

  it('limits place names to 200 characters', () => {
    expect(validate({ ...VALID, origin: 'x'.repeat(201) }, NOW).origin).toBe('Enter at most 200 characters.')
    expect(validate({ ...VALID, origin: 'x'.repeat(200) }, NOW).origin).toBeUndefined()
  })
})
