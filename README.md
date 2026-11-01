# Weather-Aware Truck Routing

A React + Django app that helps a truck driver choose the safest of up to three routes, from the
weather forecast along each route at the time the truck will be there, the load weight and the travel
time.

- **Live app:** https://spotter-full-stack-assiginment-whea.vercel.app/
- **Walkthrough:** https://www.youtube.com/watch?v=_jGSWVELKUM

## How it works

1. **Places.** From and To suggest US, Canadian and Mexican cities as you type, and any place in those
   three countries, such as an address or a ZIP code, can be typed in full. TomTom's geocoder finds
   both ends there, and the page shows the name it matched.
2. **Routes.** TomTom's truck routing (commercial vehicle, 68 mph speed limiter) returns up to three
   routes. When it returns fewer distinct ones, the server looks for more through a point beside the
   fastest route.
3. **Checkpoints and ETAs.** A checkpoint every 10, 25 or 50 miles along each route (25 by default),
   plus both ends. Each ETA is the departure time plus TomTom's own travel time to that point.
4. **Weather at each ETA.** Open-Meteo's forecast at each checkpoint's ETA: sustained wind at the
   nearest hour, and the rain and snow of the hour the ETA falls in.
5. **Risk.** The assignment's thresholds and load rules give each checkpoint a level from Low to No
   Travel, the worst of its wind, rain and snow. A missing forecast shows as No data, never as Low.
6. **Recommendation.** Routes are ranked by fewest No Travel miles, then by the assignment's order:
   fewest Severe miles, fewest High miles, lowest average risk, shortest drive. The page says why the
   top route won.
7. **Map and heatmap.** Every route and checkpoint (coloured by its risk at the ETA) is on the map.
   Pointing at a checkpoint shows its ETA and risk, a click opens its details (every route's, where
   dots sit on top of each other), and a summary of each route sits beside the map. Squares along
   the corridor show the risk at a single hour, picked with a slider from departure (+0 h) to 48
   hours after it (+48 h), and a truck on each route shows where it is at that hour.

## Key decisions

Where the requirements leave room, these are the choices made. [Assumptions](#assumptions) has all
of them with the reasons; the numbers in parentheses point there.

- **Edges of the risk table.** Each level starts at its lower number, so wind of 34.6 mph is Moderate
  and 35 mph is High; a value the table puts in two levels, such as rain of exactly 0.25 in/hr, takes
  the higher one. Only No Travel rain and snow start just above their numbers, as the table's ">"
  says, so rain of exactly 1.00 in/hr is Severe. (1)
- **What is rated.** Sustained wind at 10 m at the hour nearest the ETA (gusts are shown, not rated),
  and rain including showers and snowfall in the hour the ETA falls in. (2, 7)
- **Load rules** apply on the same wind ranges: over 30,000 lb, 45 up to 55 mph is No Travel; over
  40,000 lb, 35 up to 45 mph is Severe. (3)
- **No guessing.** A missing forecast value makes the risk No data; it never counts as Low. (4)
- **ETAs** come from TomTom's timing along the route, for a truck limited to 68 mph (TomTom's own
  truck speeds reach 75 to 80 mph and made ETAs too early). Driving is non-stop. (6)
- **Ranking.** Fewest No Travel miles comes first, before the assignment's order. A route with any No
  Travel miles is marked unsafe; if every route is, the least bad one is still recommended, with a
  warning. (10, 11)
- **Balancing risk and travel time** follows the assignment's order, which lists travel time last:
  time decides only between routes that tie on risk as the route list shows it. A slower route can
  therefore win on slightly lower risk; when risk decided between the top two routes, the sentence
  under the recommendation names the fastest route and how much faster it is. (10, 27)
- **Three routes.** TomTom's own alternatives first; any missing ones come from a point beside the
  fastest route, searched for until 14 seconds after the start (or 12 seconds after TomTom's first
  answer, on long trips) and kept within 1.5 times the fastest drive when possible. (13 to 15)
- **Heatmap.** Slider position h shows the whole corridor at departure + h hours, with each route's
  truck where it is then; the checkpoint dots keep their own ETAs. This is my reading of the "0–48
  hour forecast slider", which doesn't say where the hours count from: counting from departure keeps
  the slider on the trip, which can leave up to 13 days ahead, while hours counted from now could all
  fall before it. The squares come from a grid around all routes, as fine as a budget of about 300
  forecast locations per default plan allows (coast-to-coast plans need about 350 to 500). (16, 17)
- **Free weather data.** Open-Meteo's free API; when its rate limit is hit, the page says when to try
  again. TomTom's results are never cached, as its terms require. (18 to 20, 24)
- **City suggestions** in From and To are an addition beyond the requirements, to make the form
  quicker to fill in. (39)

## API choices

Free tiers as of October 2026.

- **TomTom** for routing, geocoding and the city suggestions. Its truck routing (a commercial
  vehicle, with the truck's top speed) returns up to two alternatives in the same request, each with
  the travel time to points every few miles along it, which gives every checkpoint its ETA. Free
  tier: 20,000 routing and 20,000 geocoding requests a month, and 2,500 Search API requests a month
  for the suggestions, at up to 5 requests a second each, with no credit card. Once an allowance is
  used up, its requests are refused until the next month. The free licence is for evaluation, which
  fits this demo. (6, 12, 39)
- **Open-Meteo** for the forecasts: hourly forecasts for up to 1,000 locations in one request, with no
  key, so a plan's checkpoints and heat squares come in one or two requests. In the US its default
  model is NOAA's HRRR (3 km) for about two days, then GFS. Free tier: 600 calls a minute, 5,000 an
  hour, 10,000 a day and 300,000 a month per IP address, for non-commercial use; here each location
  is one call. The data are CC BY 4.0, credited on the map. (17 to 19)
- **MapLibre GL JS with OpenFreeMap** for the map, both free and without a key. MapLibre (open
  source, BSD-3-Clause) draws vector maps with WebGL and recolours features in place, so the slider
  recolours the heat squares without new data. OpenFreeMap serves the base map's tiles and style with
  no limits on map views or requests; it is funded by donations and offers no service guarantee.

## Known limitations

- Checkpoint details open from the map with a mouse or touch. For keyboard and screen-reader users,
  the route list carries the figures the recommendation rests on, as text. (34)
- ETAs assume non-stop driving with no rest breaks, and TomTom isn't told the truck's weight or size
  (the app knows the load, not the truck), so TomTom's weight and size limits, such as low bridges,
  aren't applied. (6, 12)
- Forecasts reach 15 days ahead; checkpoints after that show No data, with a warning. (18, 21)
- Open-Meteo's free limits count per IP address, and on Vercel those addresses are shared, so a plan
  can occasionally be asked to try again later. (19, 20)
- Picking a suggested city fills in its name, which the plan then looks up like typed text. (39)

## Running it locally

Backend (Python 3.14):

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env        # then fill in TOMTOM_API_KEY
.venv/bin/python manage.py runserver 8001
```

Frontend (Node 24), in a second terminal:

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5174; requests to /api go to Django on port 8001
```

To run the whole app as one service, as it is deployed: run `npm run build` in `frontend/`, then
start Django (with `DJANGO_DEBUG=1`) and open http://127.0.0.1:8001/.

Settings come from environment variables, read from `backend/.env` locally (see
`backend/.env.example`):

| Variable | Purpose |
|---|---|
| `TOMTOM_API_KEY` | TomTom routing, geocoding and place suggestions. |
| `DJANGO_SECRET_KEY` | Required unless `DJANGO_DEBUG=1`. |
| `DJANGO_DEBUG` | `1` for local development only. |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated host names; `*.vercel.app` is added automatically on Vercel. |

The base map comes from OpenFreeMap and needs no key.

## Tests

```bash
(cd backend && .venv/bin/python -m pytest)    # 391 tests
(cd frontend && npm test)                     # 244 tests
```

TomTom and Open-Meteo are never called by the tests: their HTTP responses are faked. The frontend
tests run in US Central time, so the date and daylight-saving checks give the same results anywhere.
Types are checked with pyright (`npx pyright@1.1.414 -p pyrightconfig.json backend` from the
repository root, after the backend setup) and `tsc` (run by `npm run build`), and the frontend is
linted with oxlint (`npm run lint` in `frontend/`).

## Project structure

```text
backend/
  config/          settings, URLs, and the view that serves the built page
  planner/
    clients/       TomTom and Open-Meteo
    logic/         risk rules, checkpoints and ETAs, ranking, route comparison, the heatmap grid
    services/      putting a plan together; the search for extra routes
    views.py       the two API endpoints
    tests/
frontend/src/
  api/             requests to the API
  components/      form, recommendation, route list, heatmap slider, map key
  map/             the MapLibre map: layers, heat cells, trucks, checkpoint cards
  lib/             formatting, time zones, form checks, the "why" sentence
```

## Hosting

Vercel, as one Django app: Django serves the page and the API, and Vercel's CDN serves the built
JavaScript and CSS. `vercel.json` sets Vercel's Django preset and builds the frontend before Django's
static files are collected; `TOMTOM_API_KEY` and `DJANGO_SECRET_KEY` are set in the project's
environment variables. (26)

## API

`POST /api/plan/` with a JSON body:

| Field | Type | Notes |
|---|---|---|
| `origin`, `destination` | string | Places in the US, Canada or Mexico, 2 to 200 characters. |
| `departure` | string | ISO 8601 with a time-zone offset, from one hour ago to 13 days ahead. |
| `load_lb` | number | 0 to 200,000. |
| `interval_miles` | 10, 25 or 50 | Optional, default 25. |

The response (gzipped for clients that accept it) has:

- `origin`, `destination`: what was typed (`query`), TomTom's name for the match (`name`, with the
  country added for places outside the US), `country_code`, `lat` and `lon`.
- `departure` (UTC), `load_lb`, `interval_miles`.
- `routes`: for each route, `id` (A to C), `source` (`tomtom` or `via_point`), `distance_miles`,
  `travel_time_s`, `arrival`, `geometry` (`[lon, lat]` points, simplified to within 15 m), `rank`,
  `recommended`, `summary` (`miles_by_level`, `average_risk`, `unsafe`) and `checkpoints` (`mile`,
  `lat`, `lon`, `eta`, `forecast_time`, `totals_time`, `wind_mph`, `gust_mph`, `rain_in_hr`,
  `snow_in_hr`, `wind_level`, `rain_level`, `snow_level`, `load_rule_applied`, `level`,
  `covered_miles`). `forecast_time` is the hour the wind is taken from, and `totals_time` ends the
  hour whose rain, snow and gusts are used (assumption 7). Levels run from 0 (Low) to 4 (No Travel);
  `null` means No data.
- `recommendation`: `route_id` and `warnings`.
- `warnings`: notes about the route search or forecast coverage.
- `heatmap`: `cell_deg` (the cell size in degrees), `band_miles` (the band kept around the routes; 0
  on the coarsest grids), `cells` (`[west, south, east, north]`), `hours` (the 49 UTC forecast hours
  shown at slider positions 0 to 48), and `levels` (`[hour][cell]`, 0 to 4 or `null`).

Every error comes back as `{"error": "..."}`, plus `fields` with a message per form field when a
field is the problem:

| Status | When |
|---|---|
| 400 | Invalid input, a body that isn't a JSON object, a place that can't be found, or no truck route between the places. |
| 405, 415 | A method other than POST, or a body that isn't sent as JSON. |
| 502 | TomTom or Open-Meteo failed, or answered with something unusable. |
| 503 | A rate limit was hit, or the server is busy fetching forecasts for other plans; `retry_after_seconds` and a `Retry-After` header say when to try again. |
| 504 | TomTom took too long. |
| 500 | No TomTom key is configured, or an unexpected error. |

`GET /api/places/?q=Denv` suggests cities for the From and To fields: `{"places": [{"name":
"Denver, CO", "also": ["Denver, Colorado"]}, ...]}`, at most 5, best first. `name` is written like
`name` above; `also` lists other ways to write it, and `q` is the start of one of them (assumption
39). `q` must be 3 to 200 characters (else 400); TomTom failures come back as above (502, 503, 504).

## Assumptions

Decisions the requirements leave open, with the reasons. [Key decisions](#key-decisions) sums up the
main ones.

<details>
<summary>All 42, grouped by topic</summary>

### Risk rules

1. **Ranges.** The table's numbers are kept. "A up to B" includes A but not B; "A to B" includes both;
   a value that falls in two levels goes to the higher one:

   | | Low | Moderate | High | Severe | No Travel |
   |---|---|---|---|---|---|
   | Wind (mph) | below 25 | 25 up to 35 | 35 up to 45 | 45 up to 55 | 55 and above |
   | Rain (in/hr) | below 0.10 | 0.10 up to 0.25 | 0.25 up to 0.50 | 0.50 to 1.00 | above 1.00 |
   | Snow (in/hr) | below 0.5 | 0.5 up to 1.0 | 1.0 up to 2.0 | 2.0 to 3.0 | above 3.0 |

2. **What is measured**. Wind is the sustained wind speed at 10 m; gusts are shown
   for information only. Rain is liquid rain including showers. Snow is the snowfall rate. Open-Meteo
   returns mph and inches directly. Its hourly rain, shower and snowfall amounts are totals for the
   hour ending at that hour's timestamp, and are used as that hour's rate in in/hr (a checkpoint
   takes them from the hour its ETA falls in, assumption 7). Rain plus showers
   is rounded to 0.001 in (the forecast's precision) so a floating-point sum cannot slip below a
   threshold.
3. **Load rules**, applied exactly as written, on the wind ranges above: 45 up to
   55 mph with a load above 30,000 lb is No Travel; 35 up to 45 mph with a load above 40,000 lb is
   Severe; 55 mph and above is No Travel for any load. A checkpoint's risk is the worst of its wind
   (after the load rules), rain and snow levels.
4. **No data**. If wind, rain or snow is
   missing for the hour, the risk is "No data", except when a known value is already No Travel,
   because then nothing missing could change the result. Likewise, rain or showers above 1.00 in/hr
   counts as No Travel even if the other value is missing, because the missing part can only add to it.

### Checkpoints and ETAs

5. **Sampling**. The interval is a setting: 10, 25 or 50 miles (default 25).
   Checkpoints sit at the origin, every interval along the route, and at the destination. If the
   destination is within 0.05 mi (about 80 m) of the last interval mark, it replaces that mark, since
   miles are shown to 0.1 mi and both would show the same mile. Each checkpoint stands for the road
   halfway to its neighbours; Severe, High and No Travel miles are counted that way.
6. **ETA**. ETA = departure time + TomTom's travel time to that point. The travel
   time comes from TomTom's progress data for the route: cumulative distance and travel time at
   points along it, every 2 to 6 miles on average. Between two such points, time is interpolated
   linearly, as TomTom documents. Guidance instructions were not used because they can be over
   100 miles apart on interstates. TomTom uses historic traffic for the departure time. ETAs assume
   continuous driving, with no rest breaks or hours-of-service limits. The truck is assumed to have
   a speed limiter set to 68 mph: most fleets use limiters, most commonly set
   between 66 and 70 mph, while TomTom's own truck speeds reach 75 to 80 mph on interstates with a
   75 mph limit, which made ETAs too early. TomTom is told this maximum speed
   (`vehicleMaxSpeed=109`, in km/h), and the ETAs still come from TomTom's travel times. Measured:
   Dallas to Denver now averages 62 mph instead of 75 and arrives about an hour later (TomTom also
   picks a shorter road at that speed), and Miami to Seattle takes 51 hours instead of 47. Roads
   where TomTom's truck speeds are already below 68 mph are unchanged, and there TomTom can still
   run a little above a lower truck limit: about 60 mph on California's I-5, where trucks are
   limited to 55 mph, so ETAs on such roads stay slightly early.
7. **Forecast hours.** Sustained wind is forecast for the hour itself, so a checkpoint takes it from
   the forecast hour nearest its ETA (exactly half past rounds up). Rain, snow and gusts are totals
   for the hour before each timestamp, so they come from the hour the ETA falls in: an ETA of 14:20
   uses the wind at 14:00 and the rain and snow from 14:00 to 15:00. An ETA on the hour falls in the
   hour that starts then, so a trip leaving at 14:00 starts with the rain and snow from 14:00 to
   15:00. A checkpoint's card shows both times. Heatmap squares follow the same rule at the slider's
   hour (always on the hour): the wind at that hour and the rain and snow of the hour that starts
   then, so a square and a dot at the same moment read the same forecast. All time math is in UTC.
8. **Forecast locations.** Checkpoint locations are snapped to a 0.02° grid (about 2 km) before the
   forecast is requested, so nearby checkpoints share one forecast.

### Ranking and recommendation

9. **Average risk** is mile-weighted, with Low = 0, Moderate = 1, High = 2, Severe = 3 and No
   Travel = 4. Miles with no data are left out of the average and reported separately.
10. **Order**: fewest No Travel miles, then the requirements' order: fewest Severe
    miles, fewest High miles, lowest average risk, shortest travel time. Values are compared as the
    route cards show them: miles to 0.1 and average risk to 0.01. Any non-zero mileage shows as at least
    0.1 mile, so a short stretch of bad weather is never hidden. Travel time is compared to the second.
    If everything else is equal, the route letter decides, so the order never depends on input order.
    This is how the requirements' "balancing weather risk and travel time" is read: their list puts
    travel time last, so it breaks ties and no trade-off is invented on top. A route can then win over
    one that is hours faster on an average risk 0.01 lower; when risk decided between the top two
    routes, the sentence under the recommendation names the fastest route and how much faster it is
    (27), so the driver sees the cost.
11. **Unsafe routes and missing forecasts**. A route with any
    No Travel miles is marked unsafe. If every route is unsafe, the least bad one is still
    recommended, with a clear warning. Miles without forecast data count toward no risk level and
    are left out of the average (they are not guessed), so a route with many of them can rank higher
    than its true risk would put it. If the recommended route has such miles, a warning says how
    many, because their risk is unknown. A route with no forecast data at all ranks last.

### Routes

12. **TomTom Routing API v1** (Calculate Route) with `travelMode=truck`, `vehicleCommercial=true`,
    `departAt` and `maxAlternatives=2`, plus `vehicleMaxSpeed=109` for the 68 mph
    speed limiter (see 6). TomTom's newer "Orbis" routing API has no truck mode, so the classic API
    is used. No vehicle weight or dimensions are sent: the app knows the load, not the truck's total
    weight, so TomTom's weight and size restrictions are not applied. A departure less than a
    minute away, or in the past hour, is sent to TomTom as "now", because TomTom wants departure
    times in the future.
13. **Distinct routes.** Two routes count as the same unless less than 90 % of each one runs within
    about 1 km of the other (measured between points every 500 m along each route). Checking both
    directions also catches a route that is another route plus a detour. On sample trips, TomTom's
    own alternatives shared under 50 % of their road.
14. **Missing routes**. When
    fewer than three distinct routes come back, the app asks TomTom for routes through points beside
    the fastest route:
    - **Placement:** at 50 %, 35 % and 65 % of its length, on both sides.
    - **Distance from the route:** 15 % of its length, at least 25 km (or 30 % of the length on
      short trips), at most 150 km.
    - **Waypoint:** each point is a TomTom circle waypoint with a radius of a third of that
      distance. The route only has to pass through the circle, so TomTom picks a sensible road
      instead of forcing a detour to one spot.
    - **Order and filtering:** points with the smallest straight-line detour are tried first.
      Points closer than 0.8 times that distance to an existing route are skipped, because TomTom
      would return the same route.
    - **Rejected results:** routes that drive back over about 5 km or more of road they already
      used (an out-and-back detour). A road within 250 m, such as the other carriageway of a
      divided highway, counts as the same road. TomTom is also asked to avoid reusing roads on
      these requests, and to avoid border crossings when both ends are in the same country.
    - **Preference:** routes within 1.5 times the fastest travel time. A slower distinct route is
      used only if nothing quicker turns up, with a warning saying how much slower it is.
    - **Order of tries:** in parallel rounds of up to four requests (TomTom's free tier allows five
      a second); a failed request only rules out that via point.
15. **Time budget**. The extra-route search may run until 14 seconds after the request started, or
    until 12 seconds after TomTom's first answer, whichever is later. Long trips need the second:
    coast to coast, TomTom took 10 to 17 seconds to answer with its alternatives, and a via request
    takes about 5 seconds, so the 12 seconds leave room for two rounds. A round of via requests
    starts only if at least 3 seconds are left, and each request gets the time left minus one
    second, which is kept for checking the routes it returns. If time runs out, or no distinct route
    can be found, fewer than three routes are shown with a warning. TomTom gets 15 seconds for the
    first request. If that times out, TomTom is asked once more without alternatives (6 seconds) and
    the via search then gets its 12 seconds, so this rare case can take about 35 seconds. If
    TomTom's per-second limit is hit, a request is repeated once after a second, if its time allows.
    Measured plans: Chicago to Denver 5 s (on Vercel), Dallas to Denver 8 to 12 s, Los Angeles to New
    York 23 s with its third route from a via point.

### Heatmap

16. **Slider.** This is my reading of the requirement's "0–48 hour forecast slider", which doesn't say
    where the hours count from or what the squares show. Position 0 is the departure time and each
    step is one hour later, up to 48 hours. Each position shows the forecast hour nearest departure +
    h, scored with the same rules and load as the checkpoints, over a band around all routes.
    Counting from departure keeps the slider on the trip: a plan can leave up to 13 days ahead, and
    hours counted from now could all fall before it. One hour across the whole corridor shows the
    weather moving as the slider moves, with each route's truck where it is then (41), while the
    checkpoint dots already give the weather at each ETA. All 49 hours arrive with the plan, so moving
    the slider never makes a network request.
17. **Grid and weather budget.** A default 25-mile plan of up to about 1,800 miles uses at most about
    300 forecast locations, half of Open-Meteo's per-minute limit, so two plans can run back to back;
    longer plans need more (see below).
    - **Cells:** square cells on a fixed latitude/longitude grid. A cell is kept when a route passes
      through it (routes are checked every 2 miles, including cells a route only clips at a corner)
      or its centre is within 30 miles of a route.
    - **Cell size:** the finest of 0.25°, 0.3°, 0.35°, 0.4°, 0.5°, 0.6°, 0.75° and 1.0° that keeps
      the 25-mile checkpoints plus the cells within 300 locations. If even 1.0° is too many, 1.5°
      and then 2.0° cells are used, keeping only the cells the routes pass through (at that size a
      30-mile band adds almost nothing). The heatmap may always use at least 80 cells, and it is
      the same for every interval.
    - **Where a cell's forecast is taken:** on the road, at the route point nearest the cell's
      centre, when a route passes through the cell, so the cell describes the road it holds (a 2°
      cell's centre can be 80 miles from it). Cells kept only for the band use their centre. A cell
      still shows one forecast, so a large cell can differ from a checkpoint dot inside it.
    - **What that gives** for three distinct routes: within about 300 locations up to about 1,800
      miles. Beyond that the 25-mile checkpoints alone keep growing, so a coast-to-coast plan needs
      about 350 to 500, depending on how much road the routes share (Miami to Seattle: about
      475 to 490).
    - **10-mile interval:** plans need more: about 100 locations for a 100-mile trip, about 350 at
      400 to 500 miles, about 850 to 900 coast to coast, and about 1,100 on the longest diagonal
      trips. Open-Meteo takes up to 1,000 locations in one request and refuses a request only once
      600 have been used that minute, so the smaller part of a split request goes first: up to
      1,599 locations not yet cached get through in a fresh minute. When the limit is hit anyway,
      for example by two plans in the same minute, the app says when to try again.

### Weather data

18. **Open-Meteo** free forecast API (non-commercial use, which fits an evaluation demo), default
    "best match" model: in the US, NOAA's HRRR (3 km) for about the first two days, then GFS.
    Forecasts reach until 23:00 UTC 15 days after today; from then on, and for any hours missing
    from Open-Meteo's answer, the map shows "No data" (a slider hour or ETA at 23:00 needs the rain
    stamped at midnight).
19. **Rate limits.** The free API allows 600 location-forecasts per minute, 5,000 per hour and 10,000
    per day per IP address, and each location counts as one. When a limit is hit, the API answers
    503 with a message saying when to try again instead of waiting on the server.
    Its `Retry-After` header points 2 seconds past the next minute, hour or midnight UTC, whichever
    limit was hit. Forecasts fetched before the limit stay cached, so the retry only fetches the
    rest. A limit that resets within 15 seconds (the per-minute count near the end of a minute, or
    Open-Meteo's one-request-at-a-time rule) is waited out once on the server instead, so the plan
    only takes a little longer.
20. **Cache.** Forecasts are cached in memory for one hour per location and UTC day, per server
    process. Within a process one plan at a time fetches forecasts, so concurrent plans for the same
    area share them instead of each using up the rate limit. Plans whose forecasts are all cached
    never wait. A plan that would wait more than 10 seconds for another plan's fetch gets a 503
    asking to try again in a few seconds. On Vercel each function instance has its own cache,
    which starts empty, and outgoing requests leave from shared addresses: other sites' use can
    count toward Open-Meteo's per-address limits, and the app then answers 503 with a time to retry.

### Inputs and time zones

21. **Departure** is entered and shown in the browser's time zone and sent to the server with its
    offset. It must be between one hour ago and 13 days ahead. Forecasts end at 23:00 UTC 15 days
    after today, so this keeps the 48 hours after departure inside the forecast (all but the last
    slider hour when planning after 22:30 UTC, and the last two after 23:30 UTC, because a slider
    hour's rain and snow are stamped an hour later). The last checkpoints of a long trip can still
    fall past the end of the forecast; they show No data, and the plan warns about it.
22. **Load** must be between 0 and 200,000 lb.
23. **Places** must be 2 to 200 characters. TomTom geocoding's top match in the US, Canada or Mexico
    is used, the countries the suggestions cover (39): searched worldwide, the Dallas ZIP code 75201
    matched Ras Al Khaimah in the UAE. A place outside them can match a similar name inside them
    ("Paris, France" matched a street in New Paris, Ohio), which is one reason the resolved names
    are shown. Canadian and Mexican names include the country, so "Paris, ON, Canada" can't be
    mistaken for Paris, Texas (Canadian cities get a comma before the province, as US ones have
    before the state). Origin and destination less than 1 km apart are rejected.
24. **No caching of TomTom results.** TomTom's terms only allow caching where its responses permit
    it, and they don't.

### Platform

25. **Versions.** Django 5.2 LTS rather than 6.1, because pytest-django does not officially support
    6.1 yet; 5.2 gets security fixes until April 2028. Python 3.14.
26. **Hosting.** Vercel Hobby with its Django framework preset, as a single Django app (one Vercel
    Function) that serves the page and the API. `vercel.json` names the preset, because Vercel's
    framework detection only reads the repository root; the build then finds `backend/manage.py`
    itself. Vercel installs `backend/requirements.txt` on Python 3.14 (`backend/.python-version`),
    runs the build command (the frontend build), then `collectstatic`, and serves `/static/` from its
    CDN. The hashed files under `/static/assets/` are
    cached for a year; the page itself never is, so a new deployment shows at once. Vercel redirects
    HTTP to HTTPS and sends Strict-Transport-Security itself, so Django doesn't (`manage.py check
    --deploy` silences W004 and W008 for that reason). A plan takes well under Vercel's 300-second
    limit for a function on Hobby, and the browser gives up after 90 seconds (assumption 33). The
    code also runs on Python 3.12, Vercel's default, in case the version file were ever missed.

### Interface

27. **Why the route was picked.** The sentence under the recommendation is worked out in the browser
    from the plan's own rounded values, in ranking order, comparing the first route with the second
    only. It names the first measure where they differ ("Fewest High miles: 0 mi, against 25.0 mi on
    Route A."), adds "Route C is 18 min faster." when drive time didn't decide and another route is at
    least a minute faster, and outlines that measure in every row of the route list. Minutes are
    counted between the drive times as shown (each rounded to the minute), so the sentence matches the
    numbers on screen. If the browser's ordering ever disagreed with the server's ranking, the sentence
    and the mark would be hidden rather than risk explaining the wrong thing.
28. **Risk colours.** Green, yellow, orange, red and plum for Low to No Travel: the order the US
    National Weather Service uses, and each step is darker than the last, so the order survives colour
    blindness (checked with a palette validator). Every colour appears with its level's name. On the
    map, dots grow with the level and with zoom, and No data dots are grey with a dark ring and, when
    zoomed in, a question mark. Pale Low dots get a thin dark ring. Zoomed far out, where checkpoints
    crowd together, Low dots shrink further so they don't hide the route lines; worse levels keep their
    size there, so risk still stands out.
29. **Spotlight.** One route at a time is drawn strongest: the recommended one, or the one the mouse
    rests on, the keyboard focuses or a click or tap pins in the route list. While a route is pointed
    at or pinned, the others fade. A click or tap only pins and unpins.
30. **Route labels on the map.** Each route gets one letter plate, placed where it runs farthest
    from the others. From zoom 7 its letter also appears along stretches no other route shares (at
    least 5 km from any other). The origin and destination are ringed and labelled with the resolved
    place names.
31. **Trip summary.** After a plan, the form folds into a summary of the trip; "Change trip" reopens
    it. A field's error message disappears as soon as that field is edited.
32. **Display precision.** Wind to 0.1 mph, rain and snow to 0.001 in/hr: the forecast's own
    precision, so a shown value never contradicts its level. The route list shows miles to 0.1, as the
    ranking compares them, except 1,000 miles or more at one level, shown as whole miles so the columns
    fit on phones.
33. **Timing.** The browser waits up to 90 seconds for a plan. The loading message changes after 25
    seconds. When a rate limit says to wait 2 minutes or less, the button stays off with a countdown;
    longer waits show the message only. While a plan is worked out, the Plan routes button names the
    server's steps in order, one every 2 seconds from the click, and stops on the last.
    The server answers in one piece, so the steps are timed, not reported progress. Screen readers get
    one status message instead of every step.
34. **Known limit.** Checkpoint details open from the map with a mouse or touch. For keyboard and
    screen-reader users, the route list carries, as text, the figures the recommendation is based on.
    Heat cells and trucks have no text of their own; the slider says which hour they show.
35. **Left out on purpose.** Each checkpoint's ETA and risk show when the mouse rests on its dot
    (assumption 40), its forecast hour and weather are in its card on the map, and each route's arrival
    is in the headline and the route list. Permanent ETA labels along the lines would crowd the map, so
    they were left out, as were a checkpoint table, a Cancel button, a "show the whole trip" control,
    the risk threshold table, a play button for the slider and details for single heat cells: the
    requirements don't ask for them, and they would crowd the map and panel. The thresholds are in
    assumption 1.
36. **Heatmap on the map.** Each cell is a square drawn under roads, boundaries and labels, so the map
    stays readable, with routes and checkpoints on top. A cell takes its level's colour. Low is a faint
    wash, so a corridor where everything is Low still shows; the other levels are nearly opaque. No
    data cells are grey and hatched. The key puts a square beside each level's dot: dots are the risk at
    each checkpoint's ETA, squares the risk at the slider's hour.
37. **Slider.** Every new plan starts it at +0 h. It moves an hour at a time to +48 h and shows the
    local day and time of the forecast hour with its offset ("+7 h"). Moving it recolours only the
    cells whose level changes and moves the trucks (41), at most once a frame. On desktop it sits
    above the map key; on phones it floats over the bottom of the map.
38. **Graphics.** The map asks the browser for its low-power GPU. On laptops with two GPUs, the faster
    one (MapLibre's default) made the first frame after a few idle seconds stall for about a second
    while the system switched GPUs. The built-in GPU keeps the slider at 60 frames a second; zooming
    can drop to about 30 on older built-in GPUs at Retina resolution. The browser can take the map's
    WebGL context away (after sleep, a GPU switch or with too many tabs open), leaving the map blank
    until it gives the context back. MapLibre then rebuilds the map's style and data (or the app
    loads the style again, if it hadn't finished loading), but not the colours and highlights the
    app keeps per feature, so the app draws those again: the heat squares, the spotlighted route and
    its truck, and the rings round the open card's dots, at the slider's current hour (the trucks go
    straight there). Slider moves, spotlight changes and plans made while the map was blank are
    drawn at the same time.
39. **Place suggestions** *(an addition beyond the requirements, to make the form quicker to fill
    in)*. From and To suggest cities as you type: once typing has paused for 350 ms and there are at
    least 3 characters, the server asks TomTom's Search API for cities in the US, Canada and Mexico
    (worldwide results put Denizli and The Hague ahead of Denver for "Den"). Nothing is looked up
    for a value the field opens with, such as after "Change trip". Only places whose name starts with
    what was typed are listed, so typing a whole name such as "Chicago, IL" leaves just that city:
    - Case, accents and punctuation don't matter ("D.C." is "DC"); an apostrophe may be left out or
      typed as a space ("OFallon", "Coeur d Alene").
    - "St.", "Ste.", "Ft." and "Mt." in a city's name read as words ("St. Lo" finds Saint Louis), but
      not after its comma, where MT is Montana.
    - A typed comma ends the city's name: "Denver, C" lists Denver, CO but not Denver City, TX.
    - The state or province may be written in full ("Denver, Colorado", "Toronto, Ontario"), using
      TomTom's own names, and outside the US the country may replace it ("Toronto, Canada").

    The list narrows at once as typing goes on, and a highlighted city stays highlighted when a
    newer answer reorders the list. Arrow keys and Enter, or a click, pick a city, which fills in its
    name; Enter with nothing highlighted sends the form and closes the list. Suggestions are only a
    shortcut: whatever is typed is what the plan looks up (in the same three countries, 23), so picking
    "Springfield, IL" plans from TomTom's match for that name. A lookup that fails just shows no
    list. The Search API has its own free allowance, separate from geocoding and routing; nothing is
    cached (assumption 24).
40. **Checkpoint label on hover.** With a mouse or trackpad, resting on a checkpoint's dot shows a
    small label with its route, mile, ETA and risk, so ETAs can be read off the map without a click; a
    click opens the full card. The label lets the pointer through, stays hidden while the map is
    dragged and isn't shown for a checkpoint the open card lists. Touch screens have no hover, so a
    tap opens the card as before.
41. **Trucks on the slider.** Each route has a truck where its ETAs put it at the slider's hour: at
    the start until it leaves, then along the route (linearly in time between two checkpoints, placed
    along the drawn line), and parked at the destination once it has arrived. The squares under a
    truck are then the weather it drives through at that hour. The map shows the truck from above,
    turned to the way the road heads, with the route's letter on its roof; a truck heading west is
    drawn mirrored, so the letter never reads upside down (the loading animation shows the same truck
    from the side). When the slider moves, the trucks drive along their routes to the new hour,
    turning with the road, and settle in about half a second for an hour's step (under a second for
    the full 48 hours). They jump straight there when the system asks for reduced motion, and a new
    plan's trucks start in place. Trucks drive non-stop, as the ETAs do (assumption 6). The
    recommended or spotlighted route's truck is dark and drawn on top; the others are grey and fade
    with their routes. Trucks show only with the slider.
42. **Overlapping checkpoints.** Where dots of several routes sit on top of each other (at the start
    and the destination, and on roads the routes share), a click lists every route's checkpoint there
    in one card: the dot clicked (the one on top, which the hover label names) and each other route's
    dot whose centre is within 6 px of it, about a dot's radius. A route with several such dots gives
    its nearest. Dots further apart aren't listed, as each can be clicked on its own. The spotlighted
    route (29) comes first, then the others in ranking order; each checkpoint gets the same section a
    single card has, with one close button at the top, and every listed dot is ringed. The order is
    kept while the card is open. A list taller than the map scrolls inside the card, which keeps clear
    of the map's edges as a single card does.

</details>
