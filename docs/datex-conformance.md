# DATEX II export: current status and the path to real conformance

This page is the honest record for `situationsToDatex`
([`packages/publishers/src/situation-datex.ts`](../packages/publishers/src/situation-datex.ts)),
exposed at `GET /datex2/situations.xml`. Read it before telling anyone —
including a NAP operator — that this export is DATEX II SRTI-conformant. It
is not, yet. It does validate against the base DATEX II v3 schemas (see
below).

## What the export contains

The route reads road situations like the other collections (same filters, same
keyset paging: the next page is in the `Link: <…>; rel="next"` header) and writes
an Exchange 2020 `messageContainer` holding one `SituationPublication` payload
and an `exchangeInformation` that names the exchange as a snapshot pull. The
payload has one DATEX `situation` per situation, carrying the situation id; its
records carry the revision as `version`:

- **A record for the situation's nature.** Its class comes from `DATEX2_RECORDS`
  in `@openconditions/model-roads` (`packages/model-roads/src/crosswalk/emitters.ts`):
  the subtype's entry, else the type's. A coverage test holds that table to
  every registered type (a code or an explicit `null`), every code to the
  DATEX II v3 vocabulary, and every code to reading back as the same kind, and
  as the very classification except where DATEX has no record for it (a vehicle
  hazard or a fire in general, roadworks of no stated kind, a closure of no
  stated scope, a speed measure of no stated kind; each with its reason). The
  inbound DATEX crosswalk is not used for export: several DATEX codes map to one
  type there, and the first one is not always the right one to write. A class
  whose schema requires its discriminator (`accidentType`,
  `roadMaintenanceType`, …) always carries one: the class's generic value
  (`accident`, `roadworks`, `badWeather`, …) where DATEX has one, else
  `other`. An `EquipmentOrSystemFault` also names the faulty equipment from
  `DATEX2_FAULTY_EQUIPMENT`, or `other` when the subtype has no DATEX
  equivalent.
- **One record per effect** in force or scheduled at the request's `at` that
  DATEX has a management record for: closures and all-lanes closures
  (`RoadOrCarriagewayOrLaneManagement`), lane closures with their lane counts,
  contraflow, speed limits (`SpeedManagement` with the limit) and diversions
  (`ReroutingManagement`). Ended effects and effects of unknown state are left
  out. Only the first effect whose record repeats the nature at the same place is
  folded into it, retaining that effect's validity, compliance and fields; a
  road closure folds into a nature record the reader takes as a closure in
  itself (a movable bridge open, traffic held). Further
  matching effects remain independent records; fields are never combined across
  effects to synthesize a restriction.
  A nature without a record of its own leads with its first effect's record.
  Generic management classifications are represented by their concrete effects,
  including scoped closures and speed records with different discriminators;
  they never add a second restriction with the parent's broader validity.
- **Record ids.** A record keeps the DATEX record id it was parsed from
  (`effect.sourceRecordRef`, without the `/<version>` the assembler appends);
  the nature record carries the situation id, or the source record id of the
  effect folded into it; any other record, and a second effect read from one
  source record, is `<situation id>#<effect id>`, so no two records share an id.
- **Probability** is required on every record, so each one states the
  situation's certainty. `unlikely` has no v3 value (v2's `improbable` was
  dropped) and travels as `_extended` with `_extendedValue="improbable"`; a
  certainty nobody stated travels as `_extended` `unknown`, never as `certain`.
- **What else describes the whole situation** travels on the leading record
  only: severity (`none` included, and `unknown` where a source declared it
  so), the informant (`source`), the first cause as `cause/causeType`
  (`DATEX2_CAUSE_TYPES`), and the text as public comments in the order the
  reader takes them back: headline, description, every other public comment.
  The description states its `commentType` (`description`), which the reader
  reads, so it comes back even where it repeats the headline; operator and
  internal comments are not published. The reader, for its part, leaves a
  comment typed `internalNote` or `dataProcessingNote` unread, and never reads
  `nonGeneralPublicComment`: nothing downstream withholds a comment once it is
  in the model. A roadworks nature record states
  the works' duration class, scale, whether they are under traffic and whether
  urgent.
- **Lanes.** A lane restriction writes its restricted lanes (or, where only
  closed lanes are known, those) as `numberOfLanesRestricted`, the lanes that
  remain fully operational where stated, and the lane total as the location's
  carriageway `originalNumberOfLanes` (an `unspecifiedCarriageway`). Restricted
  lanes none of which is known closed are an `other` lane management, not
  `laneClosures`; a lane closure with every lane open is `laneClosures` with no
  lane restricted, as the publishers who report one write it.
- **Related situations.** A plain relation to another situation is the
  situation's `relatedSituation`, referring to that situation's id in the
  publication; the reader reads `relatedSituation` (and a record's
  `situationRecordCreationReference`) as relations. A relation of any other
  kind (a detour for, a cause of) has no DATEX form and is reported.
- **Diversions** state their description (`reroutingItineraryDescription`) and
  a line route as their `alternativeRoute`.
- **Direction of traffic.** A management record states the effect's own
  direction as `applicableForTrafficDirection` where it is a compass heading
  or one of the axisless DATEX directions (both ways, rings, towns); a
  direction it shares with its place travels with the place (a bearing, an
  Alert-C direction); any other direction is reported as not exported.
- **Locations.** A `LineString` is a `LinearLocation` with its `gmlLineString`
  (latitude first); a place a location table gave (`geometryOrigin`
  `tmc_table`) is its `AlertCMethod2Point` alone, which the reader looks up
  again, so such a coarse place is no longer withheld; any other geometry is a
  `PointLocation` at its first coordinate, with its bearing. The Alert-C
  reference travels beside the coordinates, as the reader keeps it (`tmc`:
  primary and secondary location, coded and affected direction, method and
  method-4 offsets): a point's on its point location, a linear one's on a
  `SingleRoadLinearLocation`, and a point code on a line as an
  `ItineraryByIndexedLocations` of the line and the point. External location
  codes travel as `externalReferencing`. A reference with no coded direction
  (a v2 `both` has none in v3), an extent, or offsets that are not whole
  metres cannot be written (`alertCDirection` is required) and is reported.
- **Compliance.** Network-management records (`RoadOrCarriagewayOrLaneManagement`,
  `SpeedManagement`, `ReroutingManagement`, …) must state a `complianceOption`:
  the effect's `mandatory` or `advisory`, else `_extended` with
  `_extendedValue="unknown"` rather than a guess.
- **Timing fidelity.** Simple effect intervals use effect → phase → situation
  fallback. A filtered or own-place management effect cannot be recreated by a
  broader root nature record. Periods and exceptions are written as
  `validPeriod` and `exceptionPeriod`: one window as its start and end
  instants, a period that only starts (with no overall end) as its start
  instant, a daily or weekly recurrence as its times of day, days and months
  from the start of its first occurrence to the end of its last. The reader
  keeps a period's instants to the second: a window as its start and length,
  a period that only starts as days overlapping from that instant, and a
  recurrence's bounds as the first and last occurrence they admit; a bound
  inside an occurrence (one the overall window does not already cut) cuts it
  short in a way no local date can say, and is reported as
  `unsupported_schedule`, leaving the record's time unknown rather than
  widened. DATEX times of day carry no zone and the
  reader places them in the zone of the record's location, so a schedule in
  another zone, or of a shape the reader would take back differently (a count
  of occurrences, days of the month, excepted dates, a length longer than its
  times of day), still withholds the situation with `unsupported_timing`. The
  emitter does not approximate such rules as continuous intervals. Suspended
  validity is preserved; unknown or terminal root lifecycle is withheld.
- **Delay supplements.** A temporally eligible delay supplements the record of
  the source record it was read with, else the leading record, when its place,
  interval and lifecycle agree with that record's: its band, description
  (`delaysType`), duration, the capacity that remains and, on an
  `AbnormalTraffic` record only, the queue length. Ended/unknown delays and
  mismatched contexts are omitted with diagnostics. Different eligible delays
  cannot share one record's supplement and are all omitted with
  `conflicting_effects`; equivalent delays may share it.
- **Validity.** DATEX requires an `overallStartTime`. A situation without a
  declared start is stated valid from its record version time, the earliest
  moment it is known to hold.
- **Road name and number** travel in the location's
  `supplementaryPositionalDescription/roadInformation`, the only place v3
  allows them on a point or plain linear location, one `roadInformation` per road. The roads
  reader takes the first back from there, as it does for DGT and CITA, which
  name their roads in the same place. `roadName` is a plain string there, not
  a multilingual one, so the export writes a road's first name only, and a
  re-ingested export keeps the name's text but not its language (it comes back
  as `und`). A multilingual road name the reader meets elsewhere (a v2 name, a
  v3 `linearElement`) keeps every language it carries.
- **Publication language.** The payload's required `lang` is the default
  language of its text: the one language every exported headline and road
  name is in, `mul` when they differ, `und` when there is none. Every headline
  value also states its own language.

A situation is **omitted entirely** when any of its effects is vehicle-specific
or restriction evidence. DATEX output cannot carry an effect's vehicle
conditions faithfully, and exporting such a closure without them would widen it
to every vehicle. A situation with no record DATEX can write is omitted as well.

## Current status: base-schema valid, not profile-conformant

The emitter hand-builds XML with `fast-xml-parser` (no usable JS DATEX II
writer exists), mirroring the reader in `@openconditions/roads`, and its output
re-ingests through our own parser as the same situations: a full closure stays a
full closure with its validity and place, and roadworks with a lane closure and
a speed limit stay one situation with both effects
([`packages/publishers/src/__tests__/situation-datex.test.ts`](../packages/publishers/src/__tests__/situation-datex.test.ts)).
[`datex-roundtrip.test.ts`](../packages/publishers/src/__tests__/datex-roundtrip.test.ts)
does the same for every real DATEX situation fixture (DGT, DIR, CITA,
Flanders, Hrvatske ceste, NDW's full snapshot, restrictions and VILD-placed
records): it parses the fixture, exports it at its publication time,
validates the export against the schemas below, reads it back and compares
both passes field by field. Its `CANNOT_EXPRESS` list names, with reasons,
every difference left (vehicle-specific and restriction-evidence situations
withheld, Alert-C codes without an Alert-C direction, the reader's derived
`planned` flag and severity source, roadworks of no stated kind, record ids
DATEX cannot share), so a regression or an improvement shows up there.
That proves internal consistency. Like the TraFF emitter, it replaces characters
XML 1.0 cannot carry (C0 controls other than tab, line feed and carriage return,
unpaired surrogates, U+FFFE, U+FFFF) with U+FFFD in every text and attribute
value.

### What is validated

[`situation-datex-schema.test.ts`](../packages/publishers/src/__tests__/situation-datex-schema.test.ts)
validates the export with libxml2 (the MIT-licensed
[`xmllint-wasm`](https://github.com/noppa/xmllint-wasm) build, no system
packages) against the official schemas:

- **DATEX II v3.7**, all per-namespace XSDs from
  <https://docs.datex2.eu/downloads/modelv37/> (`D2Payload` imports every
  namespace, so the whole set is needed);
- **Exchange 2020.1**, `cisxsd.zip` from
  <https://docs.datex2.eu/exchange-2020/downloads/>, for the
  `messageContainer` root and `exchangeInformation`.

It writes one situation for every classification `DATEX2_RECORDS` has a record
for, and a set covering every effect record, the folded and leading-effect
cases, an effect at its own place, every certainty, unknown compliance, a
missing start, a fault with named equipment, and `Point`, `LineString`,
`Polygon` and `GeometryCollection` locations with and without road names, an
Alert-C table place, a bearing and external codes, periods and exceptions,
causes, comments and relations, a queue, a diversion route, and two effects of
one source record.

The schemas are **not vendored**: datex2.eu publishes them with no licence or
redistribution terms (only "Copyright © DATEX II"), which does not permit
copying them into this Apache-2.0 repository. The test helper
([`helpers/datex-schemas.ts`](../packages/publishers/src/__tests__/helpers/datex-schemas.ts))
downloads them into `packages/publishers/node_modules/.cache/datex2-v3.7/` and
holds every file to a pinned SHA-256 (retrieved 2026-10-15), so an upstream
change fails the test instead of moving the schema silently. CI (`pnpm test`)
always runs it and fails if the schemas cannot be fetched; a local run without
network and without a cache skips it with a message.

Concretely, the export is:

- **NOT SRTI-profile-conformant.** DATEX II SRTI (Safety-Related Traffic
  Information — <https://datex2.eu/user-domains/srti/>) has its own
  recommended reference profiles, subsets of the base DATEX II v3 schemas for
  a feed of safety-related messages. This export is not such a feed, and we
  generate no profile schema and do not validate against one (see below).
- **NOT NAP-publication-ready.** A EU National Access Point (NAP) expects a
  feed that passes the schema/profile it registers against. Base-schema
  validity is not that, and is not something we should claim supports "NAP
  readiness."
- **Valid against the base schemas, with pragmatic choices that a profile may
  reject:** a single feed-level publication-creator country where the
  aggregate spans many (the route passes none, so it is the ISO 3166-1
  user-assigned `zz`); every location reduced to a representative point (see
  below); generic or `other` discriminators where the classification is no
  more specific; and the extended `unknown` compliance and `improbable`
  probability above.

None of this is new information hidden from operators — it is stated
directly in the `situation-datex.ts` module doc comment, which links back to
this page.

## Point-geometry correctness

One thing this export gets right, and must keep getting right: **a point
sensor's `Point` geometry is never buffered into a fabricated linear or area
location.** `buildLocation()` writes a `LineString` the situation already has
as a `loc:LinearLocation` of exactly its coordinates, and every other geometry
— `Point`, `Polygon`, `GeometryCollection` — as a `loc:PointLocation` at a
representative first coordinate (see `representativePoint()`). A record of an
effect with a location of its own carries that location. There is no code path
anywhere in `packages/publishers` or `packages/roads` that grows a point into a
synthetic segment, buffered polygon, or invented linear reference. Areas and
OpenLR references remain a gap — see "What full conformance requires" below —
whose fix is a correctly-modeled location, never one fabricated from a point.

The tests in
[`packages/publishers/src/__tests__/situation-datex.test.ts`](../packages/publishers/src/__tests__/situation-datex.test.ts)
round-trip `Point` and `LineString` locations and assert that a `LineString`
is written as a `loc:LinearLocation` of its own coordinates.

`loc:PointLocation` is a valid DATEX II v3 location type for a point sensor and
needs no linear geometry. Only CIFS (not built) has an open, undecided question
about how a point-sensor reading maps onto a required linear `polyline`.

## What full SRTI conformance actually requires

The base-schema gate exists; the profile work does not:

1. **Publish a dedicated SRTI feed against the reference profiles.** Not
   done. The v3 SRTI recommended reference profiles
   (<https://docs.datex2.eu/recommended-profiles/rrp/srti/>) are eight
   category profiles, (a) temporary slippery road to (h) exceptional weather
   conditions, each a subset of the v3 Situation model, documented and
   generated in the DATEX II webtool. They describe a feed of safety-related
   messages only, not a general situation export: `/datex2/situations.xml`
   publishes every road situation and stays "valid against the base v3.7
   schemas, not SRTI-profile-conformant". An SRTI feed would need its own
   route, and with it:
   - a marker in the situation model for what is safety-related, set by
     parsers from their source (DATEX `safetyRelatedMessage`, an operator's
     own flag), never inferred from the type alone;
   - a mapping from situation type and subtype to the SRTI category (a–h), so
     each situation lands in exactly one profile or is left out;
   - `safetyRelatedMessage` set to `true` on every record it writes;
   - the profile schemas generated in the webtool, pinned like the base set
     (step 2), with the release recorded: "SRTI" without a version is not a
     checkable claim;
   - the payload's `profileName` (and `profileVersion`) naming that profile.
2. **Fetch the XSD set reproducibly, with pinned provenance.** Done for the
   base v3.7 and Exchange 2020.1 schemas (source URLs, retrieval date and
   checksums in `helpers/datex-schemas.ts`). The profile's XSD bundle needs
   the same treatment, and the same licence check before anything is
   committed.
3. **Validate in CI.** Done for the base schemas: the test runs in `pnpm test`.
   Pointing it at the profile from step 1 is what turns it into the actual
   conformance gate.
4. **Add semantic profile assertions.** Not done. Schema validity alone is
   necessary but not sufficient — SRTI also constrains _which_
   elements/enumerations are expected for which situation types. Add tests
   that assert "matches the profile's semantic expectations" for a
   representative spread of our `SituationRecord` classes (Accident,
   MaintenanceWorks, AbnormalTraffic, RoadOrCarriagewayOrLaneManagement, …).
5. **Expect the emitter to need more rework.** Base validation already forced
   the changes listed under "What the export contains"; the pragmatic choices
   above (single feed-level country, representative-point-only locations,
   generic discriminators, extended values) may still fail strict profile
   validation. Fix them against real profile validation errors, not by
   guessing.

Only once steps 1–4 are in place and green should anything describe the
SRTI feed as SRTI-conformant; the general export stays outside the profiles
either way. Until then, "valid against the base DATEX II v3 schemas, not
SRTI-profile-conformant" is the accurate description, and that's what the
code says.

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
The base-schema validator exists and passes; the SRTI profile (steps 1, 2 for
the profile, and 4 above) is deferred and explicitly not done as of this
writing. Do not remove the "NOT SRTI-profile-conformant" language from
`situation-datex.ts` or this page until the profile validation exists and
passes.
