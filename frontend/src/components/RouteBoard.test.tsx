import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { explainChoice } from '../lib/why'
import { plan, route } from '../test/fixtures'
import { RouteBoard } from './RouteBoard'

function board(routes: ReturnType<typeof route>[], pinned: string | null = null) {
  const p = plan(routes)
  const onPin = vi.fn()
  const onPoint = vi.fn()
  render(<RouteBoard plan={p} why={explainChoice(p.routes)} spotlight={pinned ?? p.recommendation.route_id} pinned={pinned} onPoint={onPoint} onPin={onPin} />)
  return { onPin, onPoint, rows: screen.getAllByRole('button') }
}

describe('route board', () => {
  it('lists routes in rank order, marks the recommended one and the column that decided', () => {
    const { rows } = board([
      route('A', { rank: 2, miles: { high: 25 }, average: 0.1 }),
      route('C', { rank: 3, miles: { severe: 25 }, average: 0.15 }),
      route('B', { rank: 1, average: 0.03 }),
    ])
    expect(rows.map(row => row.textContent?.slice(0, 1))).toEqual(['B', 'A', 'C'])
    expect(within(rows[0]).getByText('Recommended')).toBeTruthy()
    expect(rows[0].className).toContain('is-spot')
    const decided = [...document.querySelectorAll('.measure.is-decided .measure-label')].map(label => label.textContent)
    expect(decided).toEqual(['High', 'High', 'High'])
    expect(screen.getByText(/measure put Route B ahead of Route A/)).toBeTruthy()
    expect(within(rows[1]).getByText('25.0').closest('.measure')?.className).toContain('is-level-2')
  })

  it('marks unsafe routes, and the recommended one as the least bad', () => {
    const { rows } = board([
      route('B', { rank: 1, miles: { no_travel: 12.5 }, average: 0.5 }),
      route('A', { rank: 2, miles: { no_travel: 30 }, average: 1 }),
    ])
    expect(within(rows[0]).getByText('Least bad')).toBeTruthy()
    expect(within(rows[0]).getByText('Unsafe')).toBeTruthy()
    expect(within(rows[1]).getByText('Unsafe')).toBeTruthy()
    expect(within(rows[0]).queryByText('Recommended')).toBeNull()
  })

  it('shows No data for a route without forecasts', () => {
    const { rows } = board([route('B', { rank: 1, average: 0 }), route('A', { rank: 2, average: null })])
    expect(within(rows[1]).getByText('No data')).toBeTruthy()
  })

  it('does not call a route without forecasts Recommended', () => {
    const { rows } = board([route('B', { rank: 1, average: null }), route('A', { rank: 2, average: null })])
    expect(within(rows[0]).queryByText('Recommended')).toBeNull()
    expect(document.querySelector('.board-key, .measure.is-decided')).toBeNull() // no why, so nothing is marked
  })

  it('shows 1,000 miles or more as whole miles, so the columns hold', () => {
    const { rows } = board([route('B', { rank: 1, miles: { severe: 1234.5 }, average: 2.4 })])
    expect(within(rows[0]).getByText('1,235')).toBeTruthy()
  })

  it('pins a route on click and unpins on Escape', () => {
    const { rows, onPin } = board([route('B', { rank: 1 }), route('A', { rank: 2, average: 0.1 })], 'A')
    expect(rows[1].getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rows[0])
    expect(onPin).toHaveBeenLastCalledWith('B')
    fireEvent.click(rows[1])
    expect(onPin).toHaveBeenLastCalledWith(null)
    fireEvent.keyDown(rows[0], { key: 'Escape' })
    expect(onPin).toHaveBeenLastCalledWith(null)
  })

  it('spotlights a route while a mouse rests on it or the keyboard focuses it', () => {
    const { rows, onPoint } = board([route('B', { rank: 1 }), route('A', { rank: 2, average: 0.1 })])
    fireEvent.pointerEnter(rows[1], { pointerType: 'mouse' })
    expect(onPoint).toHaveBeenLastCalledWith('hover', 'A')
    fireEvent.pointerLeave(rows[1], { pointerType: 'mouse' })
    expect(onPoint).toHaveBeenLastCalledWith('hover', null)
    fireEvent.keyDown(document.body, { key: 'Tab' }) // :focus-visible follows the last input, as in browsers
    act(() => rows[0].focus())
    expect(onPoint).toHaveBeenLastCalledWith('focus', 'B')
  })

  it('keeps a route spotlighted while the mouse crosses the line between two rows', () => {
    const { rows, onPoint } = board([route('B', { rank: 1 }), route('A', { rank: 2, average: 0.1 })])
    const divider = rows[1].parentElement! // row A's list item: its top border lies outside the button
    fireEvent.pointerEnter(rows[0], { pointerType: 'mouse' })
    fireEvent.pointerOut(rows[0], { pointerType: 'mouse', relatedTarget: divider })
    fireEvent.pointerOut(divider, { pointerType: 'mouse', relatedTarget: rows[1] })
    expect(onPoint.mock.calls).toEqual([
      ['hover', 'B'],
      ['hover', 'A'],
    ])
    fireEvent.pointerOut(rows[1], { pointerType: 'mouse', relatedTarget: document.body }) // off the list
    expect(onPoint).toHaveBeenLastCalledWith('hover', null)
  })

  it('only pins on a tap or a click: no sticky hover or click focus keeps a route spotlighted', () => {
    const { rows, onPoint, onPin } = board([route('B', { rank: 1 }), route('A', { rank: 2, average: 0.1 })])
    fireEvent.pointerEnter(rows[1], { pointerType: 'touch' })
    fireEvent.mouseEnter(rows[1]) // the compatibility event a tap sends
    fireEvent.mouseDown(rows[1])
    act(() => rows[1].focus()) // Chrome focuses a clicked button
    fireEvent.click(rows[1])
    expect(onPoint).not.toHaveBeenCalled()
    expect(onPin).toHaveBeenLastCalledWith('A')
  })
})
