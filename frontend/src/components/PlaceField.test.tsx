import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PlaceSuggestion, requestPlaces } from '../api/places'
import { PlaceField, SUGGEST_AFTER_MS } from './PlaceField'

vi.mock('../api/places', () => ({ requestPlaces: vi.fn() }))
const lookup = vi.mocked(requestPlaces)
const places = (...names: string[]): PlaceSuggestion[] => names.map(name => ({ name, also: [] }))

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="origin">From</label>
      <PlaceField id="origin" name="origin" className="input" placeholder="City" value={value} onChange={setValue} />
    </>
  )
}

const field = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'From' })
const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const options = () => screen.queryAllByRole('option').map(option => option.textContent)

/** Presses a key in the field; true if the field kept the key's default action (Enter sends the form). */
function press(key: string): boolean {
  const event = createEvent.keyDown(field(), { key })
  fireEvent(field(), event)
  return !event.defaultPrevented
}

beforeEach(() => {
  vi.useFakeTimers()
  lookup.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('place suggestions', () => {
  it('asks for places once typing pauses, and only from 3 characters', async () => {
    lookup.mockResolvedValue([])
    render(<Harness />)
    type('De')
    await wait(1000)
    expect(lookup).not.toHaveBeenCalled()
    type('Den')
    await wait(200)
    type('Denv')
    await wait(SUGGEST_AFTER_MS - 1)
    expect(lookup).not.toHaveBeenCalled()
    await wait(1)
    expect(lookup.mock.calls.map(call => call[0])).toEqual(['Denv'])
  })

  it('lists the places and narrows them as typing goes on, to one for a whole name', async () => {
    lookup.mockResolvedValue(places('Denver, CO', 'Denver, NC', 'Denville, NJ'))
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    expect(options()).toEqual(['Denver, CO', 'Denver, NC', 'Denville, NJ'])
    expect(field().getAttribute('aria-expanded')).toBe('true')
    type('Denver, C') // before the next answer
    expect(options()).toEqual(['Denver, CO'])
  })

  it('picks a place with the arrow keys and Enter, which then doesn’t send the form', async () => {
    lookup.mockResolvedValue(places('Denver, CO', 'Denver, NC'))
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    press('ArrowDown')
    press('ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id)
    expect(press('Enter')).toBe(false)
    expect(field().value).toBe('Denver, NC')
    expect(options()).toEqual([])
    await wait(1000)
    expect(lookup).toHaveBeenCalledTimes(1) // nothing to look up for a picked place
  })

  it('keeps the highlighted place when a newer answer reorders the list', async () => {
    lookup.mockResolvedValueOnce(places('Denver, CO', 'Denver, NC')).mockResolvedValueOnce(places('Denver, NC', 'Denver, CO'))
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    type('Denve')
    press('ArrowDown')
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Denver, CO')
    await wait(SUGGEST_AFTER_MS) // the newer answer lists Denver, NC first
    expect(options()).toEqual(['Denver, NC', 'Denver, CO'])
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Denver, CO')
    press('Enter')
    expect(field().value).toBe('Denver, CO')
  })

  it('leaves Enter to send the form when no suggestion is chosen, and closes the list', async () => {
    lookup.mockResolvedValue(places('Denver, CO'))
    render(<Harness />)
    type('Denver, CO')
    await wait(SUGGEST_AFTER_MS)
    expect(options()).toEqual(['Denver, CO'])
    expect(press('Enter')).toBe(true)
    expect(options()).toEqual([]) // not left over the form while it plans
  })

  it('doesn’t open the list late when Enter came before the answer', async () => {
    lookup.mockResolvedValue(places('Denver, CO'))
    render(<Harness />)
    type('Denver, CO')
    press('Enter')
    await wait(SUGGEST_AFTER_MS)
    expect(options()).toEqual([])
  })

  it('looks nothing up for the value it opens with', async () => {
    lookup.mockResolvedValue([])
    render(<Harness initial="Dallas, TX" />) // as "Change trip" reopens the form
    await wait(1000)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('looks up a picked city again once it is typed again', async () => {
    lookup.mockResolvedValueOnce(places('Denver, CO')).mockResolvedValueOnce(places('Chicago, IL')).mockResolvedValueOnce(places('Denver, CO'))
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    fireEvent.click(screen.getByRole('option', { name: 'Denver, CO' }))
    type('Chicago')
    await wait(SUGGEST_AFTER_MS)
    type('Denver, CO') // pasted, or typed without a pause
    await wait(SUGGEST_AFTER_MS)
    expect(lookup.mock.calls.map(call => call[0])).toEqual(['Denv', 'Chicago', 'Denver, CO'])
    expect(options()).toEqual(['Denver, CO'])
  })

  it('follows a state written in full', async () => {
    lookup.mockResolvedValue([{ name: 'Denver, CO', also: ['Denver, Colorado'] }, ...places('Denver, NC')])
    render(<Harness />)
    type('Denver')
    await wait(SUGGEST_AFTER_MS)
    type('Denver, Colorado')
    expect(options()).toEqual(['Denver, CO'])
  })

  it('highlights only under a moving pointer, and forgets it when the pointer leaves', async () => {
    lookup.mockResolvedValue(places('Denver, CO', 'Denver, NC'))
    render(<Harness />)
    type('Denver')
    await wait(SUGGEST_AFTER_MS)
    const row = screen.getByRole('option', { name: 'Denver, NC' })
    fireEvent.mouseEnter(row) // the list appearing under a still pointer
    expect(field().getAttribute('aria-activedescendant')).toBeNull()
    fireEvent.mouseMove(row)
    expect(field().getAttribute('aria-activedescendant')).toBe(row.id)
    fireEvent.mouseLeave(screen.getByRole('listbox'))
    expect(press('Enter')).toBe(true) // sends what was typed, not a city the mouse passed over
    expect(field().value).toBe('Denver')
  })

  it('picks a place with a click, and closes on Escape or on leaving the field', async () => {
    lookup.mockResolvedValue(places('Chicago, IL', 'Chicago Heights, IL'))
    render(<Harness />)
    type('Chic')
    await wait(SUGGEST_AFTER_MS)
    press('Escape')
    expect(options()).toEqual([])
    type('Chica')
    expect(options()).toEqual(['Chicago, IL', 'Chicago Heights, IL'])
    fireEvent.blur(field())
    expect(options()).toEqual([])
    type('Chicag')
    fireEvent.click(screen.getByRole('option', { name: 'Chicago Heights, IL' }))
    expect(field().value).toBe('Chicago Heights, IL')
    expect(options()).toEqual([])
  })

  it('works as a plain field when suggestions fail', async () => {
    lookup.mockRejectedValue(new Error('HTTP 503'))
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    expect(options()).toEqual([])
    expect(field().getAttribute('aria-expanded')).toBe('false')
    type('Denver, CO')
    expect(field().value).toBe('Denver, CO')
  })

  it('cancels a lookup when typing goes on', async () => {
    lookup.mockImplementation(() => new Promise(() => {})) // never answers
    render(<Harness />)
    type('Denv')
    await wait(SUGGEST_AFTER_MS)
    const signal = lookup.mock.calls[0][1]
    expect(signal.aborted).toBe(false)
    type('Denve')
    expect(signal.aborted).toBe(true)
  })
})
