import type { PlaceSuggestion } from '../api/places'

/* The server's rule, word for word (backend/planner/clients/tomtom.py, starts_with_typed), so the
   list narrows between two answers exactly as the next answer will. */

/** Abbreviations read as their words in a city's own name (not after its comma, where MT is Montana). */
const ABBREVIATIONS: Record<string, string> = { st: 'saint', ste: 'sainte', ft: 'fort', mt: 'mount' }
const APOSTROPHES = /['’‘ʼʻ`]/g // dropped, so "O'Fallon", "O’Fallon" and "OFallon" compare equal

const expand = (words: string[]) => words.map(word => ABBREVIATIONS[word] ?? word)

/** Lower-case words without accents, apostrophes or other punctuation; "d.c." is "dc". */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Whether what was typed is the start of the place's name, or of another way to write it. */
export function matchesTyped(place: PlaceSuggestion, typed: string): boolean {
  return [place.name, ...place.also].some(name => startsWithTyped(name, typed))
}

/** Whether a place name starts with what was typed, ignoring case, accents and punctuation ("D.C."
 * is "DC"; an apostrophe may be left out or typed as a space), and reading "St.", "Ste.", "Ft." and
 * "Mt." in the city's name as words. The last typed word may be unfinished, so it also counts as typed
 * ("St" may become "Sterling"). A typed comma ends a part of the name: "Denver, C" is Denver in a
 * state starting with C, so not Denver City, TX; without a comma, "Chicago IL" works too. */
export function startsWithTyped(name: string, typed: string): boolean {
  const spaced = name.replace(APOSTROPHES, ' ')
  return nameStartsWith(name, typed) || (spaced !== name && nameStartsWith(spaced, typed))
}

function nameStartsWith(name: string, typed: string): boolean {
  const [city, ...rest] = name.split(',').map(words)
  const parts = [expand(city), ...rest]
  if (!typed.includes(',')) return startsWith(parts.flat().join(' '), words(typed), true)
  const [first, ...done] = typed.split(',').map(words)
  const last = done.pop()!
  if (1 + done.length >= parts.length || expand(first).join(' ') !== parts[0].join(' ')) return false
  if (done.some((part, i) => part.join(' ') !== parts[1 + i].join(' '))) return false
  return last.length === 0 || startsWith(parts[1 + done.length].join(' '), last, false)
}

function startsWith(full: string, typed: string[], expandTyped: boolean): boolean {
  if (typed.length === 0) return false
  if (!expandTyped) return full.startsWith(typed.join(' '))
  const expanded = expand(typed).join(' ')
  const asTyped = [...expand(typed.slice(0, -1)), typed[typed.length - 1]].join(' ')
  return full.startsWith(expanded) || full.startsWith(asTyped)
}
