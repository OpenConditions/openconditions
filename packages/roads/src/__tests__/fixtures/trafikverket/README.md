# Trafikverket Situation fixture

`situations.json` is **constructed from documentation, not captured live.** The
API needs a registered key, and none was used to build it. Treat it as a reading
of the documented schema, not as evidence of what the live API sends.

It follows the `data.json` response shape of the object API
(`https://api.trafikinfo.trafikverket.se/v2/data.json`, Trafikverket, CC0 1.0)
for the object type `Situation`, schema version 1.6, namespace
`road.trafficinfo`. Sources, read on 2026-10-15:

- The schema itself, `response_Situation_v1.6.xsd`, from the data portal's
  schema download (data model page,
  `https://data.trafikverket.se/documentation/datacache/data-model`). Field
  names, nesting and the documented values come from it: the seven
  `MessageType` values, `SeverityCode` 1, 2, 4, 5 with their `SeverityText`,
  `AffectedDirectionValue` `BothDirections`/`OneDirection`, `CountyNo` 0 for all
  of Sweden, `Deviation.Suspended` (new in 1.6), `Situation.Deleted`, and WKT
  geometry that may be `POINT`, `LINESTRING`, `MULTILINESTRING`, `POLYGON` or
  `MULTIPOLYGON` with an optional `Z`, in `Geometry.WGS84`,
  `Geometry.Point.WGS84` or `Geometry.Line.WGS84`.
- The documentation pages "The Request" and "The Response": the JSON envelope
  `RESPONSE.RESULT[].Situation[]`, that times are Swedish local time without an
  offset unless stated, and that `ModifiedTime` is UTC with a `Z`.
- The news item "New groundbreaking version of Situation" (2025-10-08): version
  1.6 adds `Suspended`, where earlier versions deleted and republished a paused
  situation.

Everything else is invented to exercise the parser: the ids, coordinates, texts,
`MessageCode` and `MessageCodeValue` values (only "Beläggningsarbete" and
"resurfacingWork" are documented examples), the `MessageTypeValue` values (only
"MaintenanceWorks" is a documented example), `IconId`s and times. Whether the
live answer writes an offset is not known; most times here carry one (`+02:00`,
as the documentation's own query examples write them), while the restriction's
`StartTime` and `VersionTime` carry none, as "The Response" describes.

| Situation  | What it exercises                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `…9000001` | `Färjor`, a `MULTILINESTRING` line beside a point, `BothDirections`                                               |
| `…9000002` | an `Olycka` cause with a `Hinder` deviation: the feed drops the accident and keeps the obstacle; a `LINESTRING Z` |
| `…9000003` | `Restriktion` with `TemporaryLimit` "bruttovikt 8 ton", `Suspended`, times without an offset                      |
| `…9000004` | `Trafikmeddelande` as a `POINT Z`, beside a `Vägarbete` deviation the feed drops                                  |
| `…9000005` | `Viktig trafikinformation` for all counties with no geometry: skipped and counted                                 |
| `…9000006` | `Deleted`, as a query with `includedeletedobjects` returns it: skipped                                            |
