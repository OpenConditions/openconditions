# @openconditions/hazards

The hazards ingest domain of OpenConditions: the feed shape, the products
(`alerts`, `fires`, `smoke`, `quakes`, `events`) and the formats that turn
hazard publications into the `alert` and `natural_hazard` situations and the
`fire.frp` readings of `@openconditions/model-hazards`.

- `src/cap/` reads CAP 1.2: the XML decoder (`readCapXml`), the choice of the
  messages a parse keeps (`currentMessages`: a message another message of the
  same parse updates or cancels is superseded, and every message of a
  reference chain shares the chain's group), and the mapping of one message
  onto alert situations (`capSituations`, `capOutput` with its record
  accounting). Every CAP format of the domain builds on it.
- `src/formats/cap.ts` is the `cap` format: one CAP XML document per payload of
  the `alerts` role, from a zip (DWD) or a directory walk (the ECCC Datamart),
  with an optional `index` role the walk reads and an optional `areas` role of
  warn-cell shapes (DWD's coast and lake areas) for areas named by code only.
- `nws`: the NWS `/alerts/active` GeoJSON as CAP messages, a zone-only alert
  placed at its zones' shapes (the `zones` role), in force until NWS's `ends`
  when that is later than CAP `expires`.
- `meteoalarm`: MeteoAlarm's per-country warnings (CAP as JSON), EMMA regions
  drawn from the geocode file and other codes through a vendored copy of its
  alias file (`src/formats/snapshots/meteoalarm-aliases.json`, regenerated
  with `pnpm tsx scripts/gen-meteoalarm-aliases.ts`), each warning served at
  most three minutes past its poll.
- `firms`: NASA FIRMS active-fire CSV files as transient `fire.frp` readings,
  one per pixel.
- `wfigs`: NIFC WFIGS incidents and perimeters merged into one
  `natural_hazard` per IRWIN id.
- `effis`: EFFIS burnt areas (WFS GeoJSON) as `burned_area` situations.
- `hms`: NOAA HMS smoke polygons as `smoke` situations by density.
- `usgs`: USGS earthquake GeoJSON, a recent and a window role, folded by
  shared ids.
- `eonet`: NASA EONET open and closed events, the types read first-hand
  elsewhere terminal.
- `gdacs`: GDACS RSS events with the CAP feed's areas, earthquakes and
  wildfires terminal.
- `src/geometry.ts` simplifies derived shapes, collects polygons into one
  MultiPolygon and picks a representative point.

The domain builds on the kernel and the hazards model module, never on the
assembled registry. See [feeds/README.md](../../feeds/README.md) for how a
feed is written.
