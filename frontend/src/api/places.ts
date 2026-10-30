/** Place suggestions for the From and To fields: GET /api/places/ (README "API"). */

export interface PlaceSuggestion {
  name: string // what picking it fills in, e.g. "Denver, CO"
  also: string[] // other ways to write it that typing may follow, e.g. "Denver, Colorado"
}

const TIMEOUT_MS = 8_000 // by then the user has typed on, or doesn't need the list

/** Cities whose names start with `text`, best match first. Any failure throws: callers treat it as
 * no suggestions, since the field works without them. */
export async function requestPlaces(text: string, signal: AbortSignal): Promise<PlaceSuggestion[]> {
  const response = await fetch(`/api/places/?${new URLSearchParams({ q: text })}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  })
  if (!response.ok) throw new Error(`Place suggestions failed: HTTP ${response.status}`)
  const places: unknown = ((await response.json()) as { places?: unknown } | null)?.places
  return Array.isArray(places) ? places.filter(isSuggestion).map(({ name, also }) => ({ name, also })) : []
}

function isSuggestion(value: unknown): value is PlaceSuggestion {
  const { name, also } = (value ?? {}) as Partial<PlaceSuggestion>
  return typeof name === 'string' && Array.isArray(also) && also.every(spelling => typeof spelling === 'string')
}
