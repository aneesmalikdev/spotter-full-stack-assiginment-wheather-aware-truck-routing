import type { Route } from '../api/types'
import { formatAverageRisk, formatDuration, formatRiskMiles } from './format'

export type Column = 'no_travel' | 'severe' | 'high' | 'average_risk' | 'drive'

export interface Why {
  text: string
  column: Column | null
}

/** A route with forecast data for at least one mile, so with an average risk. */
type WithData = Route & { summary: { average_risk: number } }

/** The mile columns, in the order the server compares them. */
const MILE_COLUMNS = [
  ['no_travel', 'No Travel'],
  ['severe', 'Severe'],
  ['high', 'High'],
] as const

const MINUTE_S = 60

/** The sentence saying why the rank-1 route was picked, and the board column that decided it.
 *  null when there is nothing to say (the rank-1 route has no forecast data) or when the client's
 *  own ordering disagrees with the API's rank (then the UI hides the line and the column mark). */
export function explainChoice(routes: Route[]): Why | null {
  const ordered = clientOrder(routes)
  if (!ordered.every((route, i) => route.rank === i + 1)) return null
  const [first, ...others] = ordered
  if (first === undefined || !hasData(first)) return null
  if (others.length === 0) return { text: 'The only route found.', column: null }
  const why = firstDifference(first, others[0])
  // A faster route is a trade-off only when drive time didn't decide.
  return why.column === 'drive' ? why : { ...why, text: why.text + tradeOff(first, others) }
}

/** Routes in the order the server ranks them, recomputed from the JSON values. */
export function clientOrder(routes: Route[]): Route[] {
  return [...routes].sort((x, y) => compareKeys(rankKey(x), rankKey(y)))
}

/** Why first ranks above second: the first measure, in ranking order, on which they differ. */
function firstDifference(first: WithData, second: Route): Why {
  if (!hasData(second)) return { text: 'The only route with forecast data.', column: null }
  const a = first.summary
  const b = second.summary
  const other = `Route ${second.id}`
  for (const [column, name] of MILE_COLUMNS) {
    const mine = a.miles_by_level[column]
    const theirs = b.miles_by_level[column]
    if (mine !== theirs) {
      const text = `Fewest ${name} miles: ${formatRiskMiles(mine)} mi, against ${formatRiskMiles(theirs)} mi on ${other}.`
      return { text, column }
    }
  }
  if (a.average_risk !== b.average_risk) {
    const [mine, theirs] = [formatAverageRisk(a.average_risk), formatAverageRisk(b.average_risk)]
    return { text: `Lowest average risk: ${mine}, against ${theirs} on ${other}.`, column: 'average_risk' }
  }
  if (second.travel_time_s > first.travel_time_s) {
    const minutes = shownMinutes(second) - shownMinutes(first)
    const by = minutes === 0 ? 'under a minute' : formatDuration(minutes * MINUTE_S)
    const text = `Ties with ${other} on No Travel, Severe and High miles and average risk, and is ${by} faster.`
    return { text, column: 'drive' }
  }
  return { text: `Ties with ${other} on every measure; listed first by route letter.`, column: null }
}

/** " Route C is 18 min faster." when another route shows a shorter drive, otherwise ''. */
function tradeOff(first: Route, others: Route[]): string {
  // others are in rank order, so a tie on time goes to the better-ranked route
  const fastest = others.reduce((best, route) => (route.travel_time_s < best.travel_time_s ? route : best))
  const minutes = shownMinutes(first) - shownMinutes(fastest)
  return minutes < 1 ? '' : ` Route ${fastest.id} is ${formatDuration(minutes * MINUTE_S)} faster.`
}

/** A drive time in whole minutes, as the page shows it, so a difference in a sentence matches the
 *  difference between the two times on screen (each is rounded on its own). */
function shownMinutes(route: Route): number {
  return Math.round(route.travel_time_s / MINUTE_S)
}

/** The server's ranking key (backend/planner/logic/ranking.py), on the rounded values the JSON carries. */
function rankKey(route: Route): (number | string)[] {
  const { miles_by_level: miles, average_risk: risk } = route.summary
  const noData = risk === null ? 1 : 0
  return [noData, miles.no_travel, miles.severe, miles.high, risk ?? Infinity, route.travel_time_s, route.id]
}

/** As Python compares tuples: the first element that differs decides. */
function compareKeys(a: (number | string)[], b: (number | string)[]): number {
  const i = a.findIndex((value, j) => value !== b[j])
  return i === -1 ? 0 : a[i] < b[i] ? -1 : 1
}

function hasData(route: Route): route is WithData {
  return route.summary.average_risk !== null
}
