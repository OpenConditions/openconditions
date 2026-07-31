# TMC location tables

Some DATEX publishers never send coordinates. They say _where_ by Alert-C
location code — an integer into a national TMC location table — and expect the
consumer to hold that table. Without it such records cannot be placed on a map,
so they were dropped.

That was not a marginal loss. Two German states published nothing usable at all:

| Source                             | Records per poll | Stored  |
| ---------------------------------- | ---------------- | ------- |
| `de-ni-mobilithek` (Niedersachsen) | 1271             | **0**   |
| `de-hh-mobilithek` (Hamburg)       | 316              | **0**   |
| `de-he-mobilithek` (Hessen)        | 407              | partial |

Both feeds looked healthy on the status page — they fetched successfully and
reported no errors — which is why the per-source skip counter came first. It
sized the problem; this resolves it.

## The table

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
apart from a coordinate the publisher actually sent.

Only tables whose licence permits redistribution are vendored. A feed
referencing a country we hold no table for resolves to `no-table` and its
records stay counted as unmapped — never placed by guesswork.

## Why the version must match exactly

Location codes are renumbered between table editions, so using the wrong edition
does not degrade gracefully: it returns a _confident_ coordinate on the wrong
road. The resolver therefore refuses any record whose declared
`alertCLocationTableVersion` is not the table's own.

This is not a theoretical concern. OpenStreetMap carries German TMC codes as
tags (`TMC:cid_58:tabcd_1:LocationCode`) and was the obvious redistributable
candidate, but its data is largely LCL v8/v9 vintage from around 2010. Scored
against real records that carry both a code and coordinates:

| Table                                | Codes present | Median error         |
| ------------------------------------ | ------------- | -------------------- |
| OSM-derived (v8/v9)                  | 55%           | ~890 m, p90 4.8 km   |
| OSM-derived, on records declaring v9 | —             | 203 m                |
| **Published LCL 22.0**               | **~100%**     | **128 m, p90 710 m** |

The middle row is the point: the _mechanism_ was never wrong, the _edition_ was.
A version guard is what separates those two outcomes.

## Accuracy, and what it means

TMC is a coarse referencing system by design. Consecutive coded points on the
same road are a median 2.5 km apart, so no resolver can place an event more
precisely than the table's own granularity.

Against 1206 records carrying both a code and real coordinates, resolved
geometry lands a **median 128 m** from the record's true extent, 94.4% within
1 km. That is well inside the table's granularity, and it is why a linear
location is resolved as the _stretch between_ its two coded points — following
the table's own point chain — rather than as a single point or a straight chord
between the endpoints.

Re-check any time with:

```sh
pnpm tsx scripts/validate-tmc-table.ts ground-truth.csv
```

The SQL that produces `ground-truth.csv` is documented at the top of that
script. It runs against the real resolver, so it measures shipped behaviour
rather than a model of it.

## Unresolved records

Records that still cannot be placed are counted per source and surfaced in
`GET /feeds/status`, with the reason logged:

| Reason             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `no-table`         | No table held for that country — usually a licensing limit |
| `version-mismatch` | The record references an edition we do not hold            |
| `unknown-code`     | The referenced code is absent from the table               |
| `no-reference`     | The Alert-C block is an empty placeholder (code `0`)       |

The last is common: Brandenburg emits an otherwise-empty Alert-C block on every
record. Treating code `0` as a location would pile every such record onto one
arbitrary point, so it is explicitly rejected.
