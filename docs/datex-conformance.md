# DATEX II export: current status and the path to real conformance

This page is the honest record for `situationsToDatex`
([`packages/publishers/src/situation-datex.ts`](../packages/publishers/src/situation-datex.ts)),
exposed at `GET /datex2/situations.xml`. Read it before telling anyone —
including a NAP operator — that this export is DATEX II SRTI-conformant. It
is not, yet.

## What the export contains

The route reads road situations like the other collections (same filters, same
keyset paging: the next page is in the `Link: <…>; rel="next"` header) and writes
one DATEX `situation` per situation, with its id and revision as `version`:

- **A record for the situation's nature.** Its class comes from `DATEX2_RECORDS`
  in `@openconditions/model-roads` (`packages/model-roads/src/crosswalk/emitters.ts`):
  the subtype's entry, else the type's. A coverage test holds that table to
  every registered type (a code or an explicit `null`), every code to the
  DATEX II v3 schema, and every code to reading back as the same kind. The
  inbound DATEX crosswalk is not used for export: several DATEX codes map to one
  type there, and the first one is not always the right one to write.
- **One record per effect** in force or scheduled at the request's `at` that
  DATEX has a management record for: closures and all-lanes closures
  (`RoadOrCarriagewayOrLaneManagement`), lane closures with their lane counts,
  contraflow, speed limits (`SpeedManagement` with the limit) and diversions
  (`ReroutingManagement`). Ended effects and effects of unknown state are left
  out. An effect whose record would repeat the nature record is folded into it.
  A nature without a record of its own leads with its first effect's record.
- **Record ids.** A record keeps the DATEX record id it was parsed from
  (`effect.sourceRecordRef`); the nature record carries the situation id; any
  other record is `<situation id>#<effect id>`.
- **What describes the whole situation** — probability, severity, headline and
  a stated delay — travels on the leading record only.

A situation is **omitted entirely** when any of its effects is vehicle-specific
or restriction evidence. DATEX output cannot carry an effect's vehicle
conditions faithfully, and exporting such a closure without them would widen it
to every vehicle. A situation with no record DATEX can write is omitted as well.

## Current status: pragmatic, not conformant

The emitter produces a **pragmatic DATEX II v3 `SituationPublication`-shaped
export**. It hand-builds XML with `fast-xml-parser` (no usable JS DATEX II
writer exists), mirroring the reader in `@openconditions/roads`, and its output
re-ingests through our own parser as the same situations: a full closure stays a
full closure with its validity and place, and roadworks with a lane closure and
a speed limit stay one situation with both effects
([`packages/publishers/src/__tests__/situation-datex.test.ts`](../packages/publishers/src/__tests__/situation-datex.test.ts)).
That proves internal consistency. It does **not** prove conformance to any
official schema, because no official schema is checked anywhere in this
stack.

Concretely, the export is:

- **NOT SRTI-profile-conformant.** DATEX II SRTI (the "Safety-Related Traffic
  Information" profile — <https://datex2.eu/user-domains/srti/>) is a
  specific, versioned reference profile with its own XSD constraints on top
  of the base DATEX II v3 schemas. We have not selected a version of that
  profile, do not vendor its schema, and do not validate against it.
- **NOT NAP-publication-ready.** A EU National Access Point (NAP) expects a
  feed that passes the schema/profile it registers against. Handing a NAP
  operator this export today, unvalidated, is not something we should claim
  supports "NAP readiness."
- **NOT XSD-certified against the base DATEX II v3 schema either.** Known,
  documented pragmatic deviations exist (see the module doc comment in
  `situation-datex.ts`): a single feed-level publication-creator country where the
  aggregate spans many; every location reduced to a representative point
  (see below); road name/number placed directly under the location
  reference rather than through the fuller DATEX road-reference model.

None of this is new information hidden from operators — it is stated
directly in the `situation-datex.ts` module doc comment, which links back to
this page.

## Point-geometry correctness

One thing this export gets right, and must keep getting right: **a point
sensor's `Point` geometry is never buffered into a fabricated linear or area
location.** `buildLocation()` always emits `loc:PointLocation` for the
situation's location, whatever its geometry — `Point`, `LineString`, `Polygon`,
`GeometryCollection` — by taking a representative first coordinate (see
`representativePoint()`). Every record of a situation carries that same
location, including the record of an effect that has a location of its own.
There is no code path anywhere in `packages/publishers` or `packages/roads`
that grows a point into a synthetic segment, buffered polygon, or invented
linear reference. Precise linear/OpenLR location references for extended
(non-point) situations are a real gap — see "What full conformance requires"
below — but the fix for that gap is to add a correctly-modeled linear
location, never to fabricate one by buffering a point.

The tests in
[`packages/publishers/src/__tests__/situation-datex.test.ts`](../packages/publishers/src/__tests__/situation-datex.test.ts)
round-trip `Point` locations. No test asserts that a `LineString` location is
written as a `loc:PointLocation` without a `linearLocation` or `area` element.

`loc:PointLocation` is a valid DATEX II v3 location type for a point sensor and
needs no linear geometry. Only CIFS (not built) has an open, undecided question
about how a point-sensor reading maps onto a required linear `polyline`.

## What full SRTI conformance actually requires

This is real infrastructure work, not a labeling exercise, and it is not
done:

1. **Select and version the official reference profile.** Pick a specific,
   dated release of the DATEX II v3 SRTI Recommended Reference Profile from
   <https://datex2.eu/> (the profile, not just the base v3 schemas) and
   record which version we target. DATEX II profiles evolve; "SRTI" without a
   version is not a checkable claim.
2. **Vendor the XSD set reproducibly, with pinned provenance.** Download the
   profile's XSD bundle, commit it (or a reproducible fetch script) with a
   recorded source URL, retrieval date, and checksum, so the schema we
   validate against doesn't silently drift.
3. **Add an XSD validator to CI.** Wire a real XML Schema validator (e.g. via
   `xmllint` or a Node XSD library) into the test/build pipeline, gated on
   the vendored profile from step 2. This is the actual conformance gate —
   everything before it is preparation.
4. **Validate fixtures, and add semantic profile assertions.** Schema
   validity alone is necessary but not sufficient — SRTI also constrains
   _which_ elements/enumerations are expected for which situation types.
   Add fixture-driven tests that assert both "validates against the XSD" and
   "matches the profile's semantic expectations" for a representative
   spread of our `SituationRecord` classes (Accident, MaintenanceWorks,
   AbnormalTraffic, RoadOrCarriagewayOrLaneManagement, …).
5. **Expect the emitter to need rework.** The known deviations listed above
   (single feed-level country, representative-point-only locations, road
   name/number placement) are very likely to fail strict profile validation
   as-is. Budget for emitter changes once step 3 is actually running and
   producing real validation errors, not before — guessing at conformance
   fixes without a validator is how you end up in this same
   labeling-vs-reality gap again.

Only once steps 1–4 are in place and green should the module doc comment (or
this page) describe the export as SRTI-conformant. Until then, "pragmatic
DATEX II v3 `SituationPublication`-shaped export" is the accurate
description, and that's what the code says.

## NAP publication status (business-dev, not an engineering blocker)

Separately from schema conformance, actually _publishing_ to a National
Access Point is a per-member-state administrative process, not a technical
one. Per OpenConditions' NAP-publication findings (verified 2026-07-07):

- **France — `transport.data.gouv.fr`.** Fully self-service, no entity-type
  gate, already carries real-time DATEX II (Bison Futé). This is the
  realistic first-publisher target — the lowest-friction path to genuinely
  _publish_ to an EU NAP, and worth pursuing as a credibility win once
  schema conformance (above) is real.
- **Germany — Mobilithek.** Open to "another kind of organization" but
  requires a registered legal entity (an e.V.) plus a review step. Realistic
  second target.
- **Netherlands — NDW.** Requires a negotiated "Data+Diensten" agreement,
  not self-service. Consume-only for OpenConditions for now, or publication
  only via an existing market-party proxy.

Regulation (EU) 2022/670 Art. 2(14) defines "data holder" broadly (not
limited to road authorities) and Art. 3(6) explicitly permits publishing via
a proxy/aggregator — so there is a legal path for a project like this one to
publish, it just has not been exercised: no precedent exists of a
volunteer/OSM-style project publishing DATEX to a NAP. Whether a foreign or
volunteer project is actually approved in DE/FR is only knowable by
attempting registration.

**None of this NAP-publication work is a prerequisite for shipping the
export as a public HTTP route** — `/datex2/situations.xml` stays available
unconditionally as a compatibility/export baseline for anyone who wants to
pull it. It is a prerequisite for claiming this instance is a _registered
NAP publisher_, which we do not currently claim and should not claim until
both the schema-conformance work above and an actual France-first
registration attempt land.

## Tracked follow-up

This page **is** the tracked follow-up record for DATEX II SRTI conformance.
Full conformance (steps 1–4 above) is deferred, larger infrastructure work —
picking and vendoring the official schema plus wiring a CI validator — and is
explicitly not done as of this writing. Do not remove the "NOT
SRTI-profile-conformant" language from `situation-datex.ts` or this page until that
validator exists and passes.
