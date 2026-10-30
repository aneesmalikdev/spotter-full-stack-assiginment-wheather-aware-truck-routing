import { describe, expect, it } from 'vitest'
import { matchesTyped, startsWithTyped } from './placeMatch'

// The same cases as the server's (backend/planner/tests/test_tomtom_client.py).
describe('place names and what was typed', () => {
  it.each([
    ['Chicago, IL', 'Chicago, IL', true],
    ['West Chicago, IL', 'Chicago, IL', false],
    ['Chicago Heights, IL', 'chicago', true],
    ['Saint Louis, MO', 'St. Lo', true], // abbreviations read as words
    ['Fort Worth, TX', 'ft worth', true],
    ['Mount Vernon, WA', 'Mt. V', true],
    ['Sterling, CO', 'St', true], // an unfinished last word counts as typed too
    ['Saint Paul, MN', 'St', true],
    ['Bay Saint Louis, MS', 'St. Lo', false],
    ['Montréal, QC, Canada', 'montreal', true], // accents and case don't matter
    ["Coeur d'Alene, ID", 'Coeur d Al', true], // nor punctuation
    ['Denver, NC', 'Denver, CO', false],
    ['Denver, CO', '  ', false],
    ['Denver, CO', 'Denver, C', true], // a typed comma ends the city's name
    ['Denver City, TX', 'Denver, C', false],
    ['Denver City, TX', 'Denver,', false],
    ['Chicago, IL', 'Chicago IL', true], // without a comma, punctuation still doesn't matter
    ['Toronto, ON, Canada', 'Toronto, ON', true],
    ['Saint Louis, MO', 'St. Louis, M', true],
    ['Denver, CO', 'Denver, CO, US', false],
    ['Washington, DC', 'Washington, D.C.', true], // dotted initials
    ["O'Fallon, MO", 'O\u2019Fal', true], // a curly apostrophe, as phones type it
    ["O'Fallon, MO", 'OFal', true],
    ['Billings, MT', 'Billings, MO', false], // MT is Montana here, not "Mount"
    ['Billings, MT', 'Billings MO', false],
    ['Helena, MT', 'Helena MT', true],
  ])('%s starts with "%s": %s', (name, typed, expected) => {
    expect(startsWithTyped(name, typed)).toBe(expected)
  })
})

describe('other ways to write a place', () => {
  const denver = { name: 'Denver, CO', also: ['Denver, Colorado'] }
  const toronto = { name: 'Toronto, ON, Canada', also: ['Toronto, Ontario, Canada', 'Toronto, Canada'] }

  it.each([
    [denver, 'Denver, Colorado', true], // the state in full
    [denver, 'Denver, Col', true],
    [denver, 'Denver, Colorado Springs', false],
    [toronto, 'Toronto, Ontario', true],
    [toronto, 'Toronto, Canada', true], // the country without the province
    [toronto, 'Toronto, ON', true],
  ])('%o and "%s": %s', (place, typed, expected) => {
    expect(matchesTyped(place, typed)).toBe(expected)
  })
})
