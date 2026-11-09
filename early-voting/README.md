# NC Early Voting

Static page at `/early-voting/`. Same design language and no-dependency setup as
`/registrations/` (Barlow Condensed + Mulish, light nc26 panels, hand-rolled SVG).

Two parallel panels:

- **Map (left).** Districts colored by the Democratic-minus-Republican share of
  ballots recorded so far in the 2026 general, in pp. Chamber toggles above the
  map: U.S. House (14), state House (120), state Senate (50), statewide U.S.
  Senate. Colour domain is the widest district lead rounded up to 10 pp.
- **Trajectory chart (right).** Cumulative ballots by day, aligned by days
  before election day. Current election drawn as D/R/U lines; two "compare
  with" dropdowns add past general elections as dashed totals (2024, 2022,
  2020, 2018). 2016 is excluded because its absentee table is empty.

## Data

`tools/export-early-vote.mjs` reads the `absentee_YYYYMMDD` tables in the
Carolina Elections MySQL database. Each row's `ElectionDate` is the ballot
activity date (contrary to earlier assumptions elsewhere in the ecosystem, a
real per-ballot date exists). Party codes: 1 R, 2 D, 6 U, everything else
"other". Every election is windowed to [election day −120d, +45d] because the
2024 file contains rows dated 2204. District ids match the geometry files
(`HD-1`, `SD-01`, `NC-01`, `NC-SEN`); the exporter output is validated against
every geometry feature.

Refresh:

```sh
cd early-voting
MYSQL_PASSWORD=... node tools/export-early-vote.mjs
```

Geometry is copied from `carolina_elections/jlf-elections/plugin/data/geo/`
(already committed under `data/geo/`).

## Verify

Syntax checks and data/geo coverage checks pass; all assets serve over local
HTTP. Not browser-tested — check the map toggles and chart visually before
pushing.
