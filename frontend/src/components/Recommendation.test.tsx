import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { explainChoice } from '../lib/why'
import { plan, route } from '../test/fixtures'
import { Recommendation } from './Recommendation'

const plain = (text: string | null) => (text ?? '').replace(/ /g, ' ')

function show(routes: ReturnType<typeof route>[], warnings: string[] = []) {
  const p = plan(routes)
  p.recommendation.warnings = warnings
  render(<Recommendation plan={p} why={explainChoice(p.routes)} headingRef={{ current: null }} />)
}

describe('recommendation', () => {
  it('names the route to take, when it arrives, and why', () => {
    show([route('B', { rank: 1, average: 0.03 }), route('A', { rank: 2, average: 0.1, travel: 45_000 })])
    expect(screen.getByRole('heading', { level: 2, name: 'Take Route B' })).toBeTruthy()
    expect(plain(screen.getByText(/^Arrives/).textContent)).toBe('Arrives Sun, 10:00 PM CDT')
    expect(screen.getByText(/^Lowest average risk/).textContent).toBe(
      'Lowest average risk: 0.03, against 0.10 on Route A. Route A is 17 min faster.',
    )
  })

  it('says travel is not advised when even the best route is unsafe', () => {
    const warning = 'Every route has No Travel conditions. Route B is the least bad option, but travel is not advised.'
    show(
      [route('B', { rank: 1, miles: { no_travel: 12.5 }, average: 0.5 }), route('A', { rank: 2, miles: { no_travel: 30 }, average: 1 })],
      [warning],
    )
    expect(screen.getByRole('heading', { level: 2, name: 'No travel advised' })).toBeTruthy()
    expect(screen.getByText(warning)).toBeTruthy()
    expect(plain(screen.getByText(/^Least bad option/).textContent)).toBe('Least bad option: Route B, arrives Sun, 10:00 PM CDT')
    expect(screen.getByText(/^Fewest No Travel miles/).textContent).toBe('Fewest No Travel miles: 12.5 mi, against 30.0 mi on Route A.')
  })

  it('says the risk is unknown when no route has forecast data', () => {
    const warning = 'No forecast is available, so the weather risk is unknown.'
    show([route('B', { rank: 1, average: null }), route('A', { rank: 2, average: null })], [warning])
    expect(screen.getByRole('heading', { level: 2, name: 'Weather risk unknown' })).toBeTruthy()
    expect(screen.getByText(/^Fastest route: Route B/)).toBeTruthy()
    expect(screen.getByText(warning)).toBeTruthy()
  })
})
