# NC Voter Registration by County

Static page at `/registrations/` on johnlockefoundation.github.io. No build step,
no dependencies: plain HTML/CSS/JS, an SVG county map, and hand-rolled SVG donut
charts. Data is a pre-generated JSON file, so the page works entirely from
GitHub Pages with no live database access.

## What the page does

- **Map (fixed monthly view).** All 100 counties, colored by the change in the
  Democratic-minus-Republican share of registered voters between the latest
  weekly snapshot and the snapshot four weeks earlier (percentage points).
  Diverging scale, 95th-percentile domain so one outlier cannot flatten the map.
- **County card (right).** Click a county (or a table row). Two date dropdowns
  covering every weekly snapshot since January 2008 give exact registration
  figures at each date and the change between them, plus the D−R share change.
  Donut charts show the partisan split (Dem/Rep/Unaff/other parties) and the
  racial split (White/Black/Other) as of the "to" date. The map never changes.
- **Table (below).** All counties with its own from/to selectors, sortable
  columns, and a search box. Statewide totals pinned on top. Row click selects
  the county above.

## Data

Source: the Carolina Elections MySQL database, `VoterRegistrations` (weekly per
county since 2008-01-01; county 1 is the statewide totals row) joined to
`Counties` for names. Party columns are used as published; the six minor parties
(Green, Constitution, Libertarian, No Labels, Justice for All, We the People)
are summed into "Other parties". Racial columns are White/Black/Other as
published.

## Refresh the data

```sh
cd registrations
MYSQL_PASSWORD=... node tools/export-data.mjs   # writes data/registrations.json + .gz
```

Env defaults match the other Carolina Elections loaders (`MYSQL_HOST`,
`MYSQL_USER`, `MYSQL_DATABASE`, `MYSQL_CLIENT`). The exporter delta-encodes each
series (first value absolute, rest week-over-week differences) and writes a
gzip twin; `app.js` fetches the `.gz` when the browser supports
`DecompressionStream` and falls back to the plain JSON otherwise. Current sizes:
~1.8 MB raw, ~0.6 MB gzipped, 806 weeks × 101 rows.

Geometry is built once (already committed):

```sh
node tools/build-geo.mjs   # Census boundaries via Plotly's dataset, NC only, simplified
```

County names are validated against the registration data at build time.

## Verify

`node --check app.js` checks syntax only. Rendering has not been browser-tested;
open `/registrations/` locally (`python3 -m http.server` from the repo root) to
check the map, card, and table visually before pushing.
