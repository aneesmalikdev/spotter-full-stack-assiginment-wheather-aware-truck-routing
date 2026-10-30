import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { WORKING } from './components/Status'
import { heatmap, plan, route } from './test/fixtures'

vi.mock('./map/RouteMap', () => ({ RouteMap: () => <div data-testid="map" /> })) // jsdom has no WebGL
vi.mock('./api/places', () => ({ requestPlaces: () => Promise.resolve([]) })) // only plan requests reach fetch

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fillTrip() {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: ' Dallas, TX ' } })
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'Denver, CO' } })
  fireEvent.change(screen.getByLabelText('Load weight'), { target: { value: '35,000' } })
}

const planButton = () => screen.getByRole('button', { name: /Plan routes|Planning/ })

/** Fetch answers given one at a time by the test, to act while a request is in flight. */
function controlledFetch() {
  const pending: ((response: Response) => void)[] = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
  return async (status: number, body: unknown) => {
    const resolve = pending.shift()!
    await act(async () => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))
  }
}

const NOT_FOUND = 'Couldn\'t find "qwxzzy". Try adding a state or country.'
const TWO_ROUTES = () => plan([route('B', { rank: 1, average: 0.03 }), route('A', { rank: 2, average: 0.1 })])

/** Plans once, then reopens the form and asks for a trip from "qwxzzy", leaving the request open. */
async function replanFromUnknownPlace(reply: (status: number, body: unknown) => Promise<void>) {
  render(<App />)
  fillTrip()
  fireEvent.click(planButton())
  await reply(200, TWO_ROUTES())
  fireEvent.click(screen.getByRole('button', { name: 'Change trip' }))
  fireEvent.change(screen.getByLabelText('From'), { target: { value: 'qwxzzy' } })
  fireEvent.click(planButton())
}

afterEach(() => vi.unstubAllGlobals())

describe('app', () => {
  it('starts each plan’s heatmap at departure', async () => {
    const reply = controlledFetch()
    render(<App />)
    fillTrip()
    fireEvent.click(planButton())
    await reply(200, plan([route('A', { rank: 1 })], { heatmap: heatmap() }))
    const slider = () => screen.getByRole<HTMLInputElement>('slider', { name: 'Heatmap hour' })
    fireEvent.change(slider(), { target: { value: '12' } })
    expect(slider().value).toBe('12')
    fireEvent.click(screen.getByRole('button', { name: 'Change trip' }))
    fireEvent.click(planButton())
    await reply(200, plan([route('A', { rank: 1 })], { heatmap: heatmap() }))
    expect(slider().value).toBe('0')
    expect(screen.getByText('Squares: risk at the slider’s hour.')).toBeTruthy()
    expect(screen.getByText('Each route’s truck at the slider’s hour')).toBeTruthy()
  })

  it('leaves the slider and the squares out when a plan has no heat cells', async () => {
    const reply = controlledFetch()
    render(<App />)
    fillTrip()
    fireEvent.click(planButton())
    await reply(200, TWO_ROUTES())
    expect(screen.queryByRole('slider')).toBeNull()
    expect(document.querySelector('.key-square')).toBeNull()
  })

  it('checks the form before sending anything', () => {
    const fetchMock = answer(200, {})
    render(<App />)
    fireEvent.click(planButton())
    expect(screen.getByText('Enter where the trip starts.')).toBeTruthy()
    expect(screen.getByText('Enter where the trip ends.')).toBeTruthy()
    expect(screen.getByText('Enter the load weight in pounds.')).toBeTruthy()
    expect(document.activeElement?.id).toBe('origin')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears a field’s error as soon as it is edited', () => {
    answer(200, {})
    render(<App />)
    fireEvent.click(planButton())
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'Dallas, TX' } })
    expect(screen.queryByText('Enter where the trip starts.')).toBeNull()
    expect(screen.getByText('Enter where the trip ends.')).toBeTruthy()
  })

  it('sends the trip and shows the recommendation', async () => {
    const fetchMock = answer(200, plan([route('B', { rank: 1, average: 0.03 }), route('A', { rank: 2, average: 0.1 })]))
    render(<App />)
    fillTrip()
    fireEvent.click(planButton())
    const heading = await screen.findByRole('heading', { name: 'Take Route B' })
    await waitFor(() => expect(document.activeElement).toBe(heading)) // focus moves in an effect after the render
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ origin: 'Dallas, TX', destination: 'Denver, CO', load_lb: 35000, interval_miles: 25 })
    expect(body.departure).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00[-+]\d\d:\d\d$/)
    expect(screen.getByRole('button', { name: 'Change trip' })).toBeTruthy()
    expect(screen.queryByLabelText('From')).toBeNull() // the form folds into the summary
  })

  it('puts the server’s field errors under their fields', async () => {
    const message = 'Couldn\'t find "qwxzzy". Try adding a state or country.'
    answer(400, { error: message, fields: { origin: [message] } })
    render(<App />)
    fillTrip()
    fireEvent.click(planButton())
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByLabelText('From').getAttribute('aria-invalid')).toBe('true')
  })

  it('announces the wait in a status region that is always there', async () => {
    const reply = controlledFetch()
    render(<App />)
    // The app's own region; each place field has one for its suggestions too.
    const status = screen.getAllByRole('status').find(region => !region.closest('.place-field'))!
    expect(status.textContent).toBe('')
    fillTrip()
    fireEvent.click(planButton())
    expect(status.textContent).toBe(WORKING)
    await reply(200, TWO_ROUTES())
    expect(status.textContent).toBe('')
  })

  it('reopens the form for field errors even if it was folded while waiting', async () => {
    const reply = controlledFetch()
    await replanFromUnknownPlace(reply)
    fireEvent.click(screen.getByRole('button', { name: 'Change trip' })) // folded while busy
    await reply(400, { error: NOT_FOUND, fields: { origin: [NOT_FOUND] } })
    expect(screen.getByText(NOT_FOUND)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('From'))
    expect(screen.getByRole('button', { name: 'Change trip' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('drops a field error about a value the user has already changed', async () => {
    const reply = controlledFetch()
    await replanFromUnknownPlace(reply)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'Dallas, TX' } }) // fixed while waiting
    await reply(400, { error: NOT_FOUND, fields: { origin: [NOT_FOUND] } })
    expect(screen.queryByText(NOT_FOUND)).toBeNull()
    expect(screen.getByLabelText('From').getAttribute('aria-invalid')).toBeNull()
  })

  it('waits out a rate limit before allowing another try', async () => {
    answer(503, { error: 'The weather service is busy.', retry_after_seconds: 42 })
    render(<App />)
    fillTrip()
    fireEvent.click(planButton())
    expect(await screen.findByText('The weather service is busy.')).toBeTruthy()
    expect(screen.getByText('Try again in 42 s')).toBeTruthy()
    expect(planButton().getAttribute('aria-disabled')).toBe('true')
  })
})
