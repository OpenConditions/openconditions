# Placing DATEX records that carry no coordinates

Several German publishers were storing nothing, or nothing usable, while their
feeds reported success. The causes turned out to be four different things that
all looked identical from outside: a record went in, no geometry came out.

| Source                             | Was lost per poll | Cause                                 |
| ---------------------------------- | ----------------- | ------------------------------------- |
| `de-ni-mobilithek` (Niedersachsen) | 1271 → 0 stored   | Alert-C codes, table edition 17.0     |
| `de-sh-mobilithek` (Schleswig-H.)  | 614               | position only in `locationForDisplay` |
| `de-th-mobilithek` (Thüringen)     | 539               | position only in a point extension    |
| `de-he-mobilithek` (Hessen)        | 407               | position only in `locationForDisplay` |
| `de-hh-mobilithek` (Hamburg)       | 316 → 0 stored    | `posList` inside an unnamed `any`     |
| `de-mv-mobilithek` (Meck.-Vorp.)   | (worse) 62 stored | UTM grid stored as if it were degrees |

Only the first was a TMC problem. The rest were coordinates sitting in the
payload that nothing was reading, which is why the per-source skip counter and
its reasons came first: they turned one number into six diagnoses.

## Reading coordinates by content, not by name

Three of these were the same mistake made three times — a coordinate reachable
only through an element whose name we did not happen to check. Allow-listing
names loses to the next publisher, so two content-based fallbacks run when a
record yields no geometry by any named route:

1. **A coordinate list under any element.** A whitespace-separated run of
   numbers that reads as a sequence of plausible WGS84 pairs is a coordinate
   list, whatever holds it. Hamburg wraps its `posList` in an XSD wildcard
   literally named `any`. Two valid pairs are required, so identifiers and
   measurements do not qualify.
2. **A lone display position.** An element carrying finite `latitude` and
   `longitude` leaves — `locationForDisplay`, point extensions. This is a label
   position rather than an extent, so it is tried last.

Neither can override real geometry: both run only when nothing better was found.

## Coordinates that are not coordinates

Mecklenburg-Vorpommern publishes UTM zone 33 with the zone as an easting prefix
(`33342865` = zone 33, easting 342865) and declares no `srsName`, so its grid
values were stored as degrees — a bounding box nowhere on Earth, with no error
anywhere. A feed can now declare the CRS its payload omits (`srsName` on the
descriptor), and a coordinate outside the range degrees can occupy is refused
rather than stored. An undeclared projection is invisible until the numbers
land, where nothing can recover them; dropping the record puts it in the skip
count instead.

## The TMC location table

Germany's Location Code List **22.0** is published by the Bundesanstalt für
Straßenwesen (BASt) under **CC BY 4.0**, as a direct download in the ISO 14819-3
exchange format. It is the final edition — BASt ended maintenance in 2022 — so
the vendored snapshot is not expected to go stale.

- Source: <https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/LCL/location-code-list.html>
- Attribution: _Location Code List 22.0 — Bundesanstalt für Straßenwesen (BASt)_, CC BY 4.0
- Vendored at `packages/roads/src/tmc/snapshots/lcl-de.json` (38 387 coded points)
- Regenerate with `pnpm tsx scripts/gen-tmc-table.ts`

Every event placed from the table carries `attributes.locationTable`, so the
attribution travels with the data and consumers can tell table-derived geometry
apart from a coordinate the publisher actually sent. Only tables whose licence
permits redistribution are vendored; a feed referencing a country we hold no
table for resolves to `no-table` and stays counted as unmapped.

## Why the edition matters, and how a record can override it

Location codes are renumbered between editions, so using the wrong one does not
degrade gracefully: it returns a _confident_ coordinate on the wrong road.
OpenStreetMap carries German TMC codes as tags
(`TMC:cid_58:tabcd_1:LocationCode`) and was the obvious redistributable
candidate, but its data is largely LCL v8/v9 vintage from around 2010. Scored
against real records carrying both a code and coordinates:

| Table                                | Codes present | Median error         |
| ------------------------------------ | ------------- | -------------------- |
| OSM-derived (v8/v9)                  | 55%           | ~890 m, p90 4.8 km   |
| OSM-derived, on records declaring v9 | —             | 203 m                |
| **Published LCL 22.0**               | **~100%**     | **128 m, p90 710 m** |

The middle row is the point: the _mechanism_ was never wrong, the _edition_ was.

Niedersachsen references edition **17.0**, which is not obtainable. Refusing per
edition would lose the publisher entirely, so the table carries each coded
point's road number (96% of them) and a code from another edition is accepted
only when **every point it resolves lands on the road the record itself names**.
Agreement is evidence the code still means the same place; disagreement is
exactly the renumbering the guard exists for, and still refuses. Both ends of a
linear location must agree, and a record naming no road — or a code the table
knows no road for — is refused. Such placements are marked `viaRoadMatch`.

In production this places ~750 Niedersachsen records a poll, within the state's
own bounding box, with 6 refused because the road did not vouch for them.

## Accuracy, and what it means

TMC is coarse by design: consecutive coded points on the same road are a median
2.5 km apart, so no resolver can beat the table's own granularity. Against 1206
records carrying both a code and real coordinates, resolved geometry lands a
**median 128 m** from the record's true extent, 94.4% within 1 km. That is why a
linear location resolves to the _stretch between_ its two coded points, walking
the table's own point chain, rather than to a single point or a straight chord.

Re-check any time — it runs against the real resolver, so it measures shipped
behaviour rather than a model of it:

```sh
pnpm tsx scripts/validate-tmc-table.ts ground-truth.csv
```

The SQL that produces `ground-truth.csv` is documented at the top of that script.

## Records that still cannot be placed

Counted per source in `GET /feeds/status`, with the reason logged:

| Reason             | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `no-alertc`        | Locates itself some other way; the shape logged says how    |
| `version-mismatch` | Names an edition we do not hold, and no road vouched for it |
| `version-missing`  | Names no edition, so there is nothing to check ours against |
| `no-table`         | No table held for that country — usually a licensing limit  |
| `unknown-code`     | The referenced code is absent from the table                |
| `no-reference`     | The Alert-C block is an empty placeholder (code `0`)        |

A `no-alertc` record also logs how it describes its location — the location
element's type, its children, and the leaf names beneath. A count says a
publisher is being lost; the shape says what to build to stop losing it. Where
even the leaves are opaque (`any` inside `any`), a short excerpt of the values is
included, which is how Hamburg was diagnosed.

Two known remainders:

- **Niedersachsen, ~510 a poll** — `linearWithinLinearElement` carrying a road
  number and a distance along it. That is linear referencing against the state
  road network (NWSIB-NI), not a location table, and needs that dataset.
- **Brandenburg** emits an otherwise-empty Alert-C block with code `0` on every
  record. Treating that as a location would pile every such record onto one
  arbitrary point, so it is explicitly rejected; those records carry real
  coordinates anyway.
