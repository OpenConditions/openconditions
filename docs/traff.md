# TraFF export and consumer compatibility

`GET /traff.xml` returns one **complete public TraFF 0.8 feed**. Consumers such
as TraFF Viewer read one XML response without following HTTP pagination. A
successful response therefore has no continuation Link and no partial-feed
marker: all matching situations that the emitter can faithfully represent are
included.

Use `bbox=west,south,east,north`, `source`, `kind`, `type`, `subtype`, `domain`,
`origin`, `minSeverity`, `at`, `horizonDays`, `from`/`to`, `simplify` and `dedupe`
like the situation API. The same window validation applies. `dedupe=1` folds
across this complete selection, subject to the conservative
[compatibility rules](situation-deduplication.md). Reports remain unfolded when
`simplify` is requested. Neither `limit` nor `cursor` is accepted (400).
Clients previously following TraFF Link headers must remove their page controls.
The JSON, GeoJSON, JSON-LD and DATEX II endpoints retain their paged contracts.

## Completeness, bounds and rights

The service reads internal 5,000-record pages inside one read-only
repeatable-read transaction, evaluating all pages at one instant. It accepts
at most **20,000 candidate situations** and **32 MiB of UTF-8 XML**. Candidates
count before licence/projection omissions; effects with their own locations
may produce more than one message per situation.

If either bound is exceeded, the response is **413 JSON**, `Cache-Control:
no-store`, with guidance to narrow the bbox, source or time filters. No XML
bytes have been sent. A full world feed is not guaranteed to fit; use a bounded
area or selected sources. Empty matching selections return an ordinary empty
feed. Database errors fail the request instead of returning a partial document.

This endpoint always uses public scope, including requests carrying an operator
token. Source restrictions, per-record/upstream licence eligibility and reporter
redaction still apply. `X-Data-License` names the licences of the public
selection; `/sources` provides attribution and source terms. Keep that metadata
when distributing a downloaded XML file: TraFF has no feed-level attribution
block in this projection.

## Direction and wire precision

TraFF 0.8 supports `ONE_DIRECTION` and `BOTH_DIRECTIONS`; omitting the attribute
means both directions. The exporter explicitly emits `BOTH_DIRECTIONS` for a
location declaring `direction.value=both`, and for locations with no directional
metadata. It never writes compass/text `direction` on a bidirectional location.

An ordered GeoJSON line does **not** prove travel direction. OC's positive and
negative directions refer to the source's road-kilometre, Alert-C or OpenLR
axis. Explicit unknown, compass/bearing or source-axis directions are withheld
until a resolver can establish valid travel-ordered reference points. Raw prose
is not exported as a compass code. The same rule applies to an effect's explicit
direction; a situation with such an unsupported effect is withheld rather than
widening its restriction. Read canonical `/situations` records for that richer
information. Vehicle-specific and incomplete restrictions remain withheld, as
does a measure for every vehicle but some (an exception TraFF cannot state).

Locations of effects with their own geometry are still emitted as separate
messages. This change does not provide full geometry fidelity: lines use
endpoints, and the existing projection reduces other geometries to a point.
It does not establish a road-matched geometry or routing eligibility.

The Java `libtraff` reader uses a second-resolution ISO timestamp parser.
Receive/update/expiration/start/end times are normalized to UTC with fractional
seconds truncated on this wire projection. Stored canonical timestamps keep
their original precision. XML escaping remains the XML builder's responsibility.
Characters XML 1.0 cannot carry at all (C0 controls other than tab, line feed and
carriage return, unpaired surrogates, U+FFFE and U+FFFF) are replaced with
U+FFFD in every element text and attribute value, so source text cannot make the
feed malformed.

## Repeated restrictions

Equivalent same-type restrictions share one event. Equivalence compares canonical
fields (including effective validity, compliance and lane scope), excluding IDs
and source provenance; object key order does not matter. Different values that
round to the same wire value are still different restrictions. When same-type
restrictions within one interval differ, the containing message is withheld with `conflicting_effects`
for each implicated effect. The exporter never chooses the first, minimum or
maximum speed limit. This is a conservative OC projection policy: TraFF allows
multiple events, but cannot associate each one with its own lane scope or window.
Read the canonical JSON for the full statements.

Effects with their own geometry continue as separate messages, including when a
conflict withholds the parent message. Delay observations remain the separate
case described below. Existing single-effect field reductions are unchanged.

## Restriction timing

Each message has one start/end interval. Effects at the root location whose
interval differs from the situation are grouped by interval into separate
messages; same-type conflict checks apply within each group. Group IDs are
`<situation id>#<lexicographically first effect id>`, stable against input order.
Effects with their own geometry keep their existing separate messages and IDs.
Equivalent timestamp offsets describe the same interval. Effective validity is
an effect's override, otherwise its phase's validity, otherwise the situation's.
A classification event already represented by an effect does not create a second
restriction with the parent's broader interval or resurrect an ended effect.

The current XML emitters do not serialize recurring `periods` or `exceptions`.
They withhold the whole situation with `unsupported_timing`, pointing to the
actual root/effect/phase rule. This includes overnight and DST-dependent rules;
no finite expansion or continuous approximation is made. TraFF also withholds
suspended timing, since the current mapping cannot express suspension. Unknown
or terminal root lifecycle is withheld; ended/cancelled or unknown individual
effects are omitted with effect diagnostics. Canonical JSON retains these rules.

## Delay durations

Delay effects export `q_duration="hours:minutes"` alongside any queue `length`
in metres. Canonical delay seconds are rounded to the nearest whole minute
(30 seconds rounds upward); the inspector reports `field_precision_reduced`
when that changes the value. A positive delay below 30 seconds is omitted rather
than exported as zero. Invalid, negative or unrepresentably large durations are
also omitted with `field_not_exported`; queue length can still travel. An exact
zero is representable as `0:00`. Canonical records retain their original seconds.

A delay without an exportable duration is told by its description where it has
one: `DELAY_UNCERTAIN_DURATION`, `DELAY_LONG_DELAY` or `DELAY_VERY_LONG_DELAY`.
A duration keeps `DELAY_DELAY`, and a description beside it is reported as
`field_not_exported`, as is a delay band, for which TraFF has no event or
quantifier. A lane restriction whose lanes are restricted without any known
closed is `RESTRICTION_RESTRICTIONS`, not `RESTRICTION_LANE_CLOSED`.

Distinct duration/queue pairs remain separate events within their message;
they are neither summed nor combined across effects. Exact duplicate pairs are
collapsed. Each effect's location, effective validity and applicability govern export as
described above.

The pinned Java reader **accepts but discards `q_duration`**: its deserializing
constructor leaves duration parsing unimplemented. The independent check verifies
the emitted duration attributes with the JDK XML parser, then verifies reader
acceptance and preservation of event count and queue length. It does not claim
that this reader can display the delay duration.

## Event types

Only event types released in TraFF 0.8 are written: the event list entries
whose "Since" column names a version. The list also holds unreleased and
reserved types (bridge and tunnel closures, avalanche risk, several equipment
faults, the carpool-lane and low-emission-zone restrictions); the reference
reader takes those as `INVALID`. Bridge and tunnel closures are therefore
`RESTRICTION_CLOSED`, an HOV restriction is `CARPOOL_LANE_OPERATIONAL`, and a
subtype without a released event takes its type's event (or none). Each event
is written in its class, including the compound `EQUIPMENT_STATUS` class. A
detour is noted only when it is stated to be signed, as
`S_DIVERSION_FOLLOW_DIVERSION_SIGNS`; TraFF 0.8 has no note that a diversion is
merely in operation, so an unsigned detour is reported as `field_not_exported`.
A forecast message carries `forecast="true"`.

## Independent reader check

CI runs this check in the `interop` job. It exercises the actual upstream
`TraffFeed.read` with emitted bidirectional points/lines, canonical
fractional/offset timestamps, empty and withheld feeds, future effect intervals,
5,001 distinct messages, one message per event type the registry crosswalk can
name (each read back as its own type and class, never `INVALID`), and every
effect event with its quantifiers, diversion note, forecast flag, urgency and
escaped road attributes:

```bash
pnpm install --frozen-lockfile
pnpm build
# Requires git, curl and JDK 17+; set JAVA_HOME if Java is not on PATH.
bash scripts/traff-interop/check.sh
```

It clones [`libtraff` at ae6e2ae](https://gitlab.com/traffxml/libtraff/-/tree/ae6e2ae72c6950949864306d64dabd8091bd0f15)
into a disposable temporary directory, verifies SHA-256 digests for its declared
Simple XML 2.7.1 and SLF4J API 1.7.12 runtime jars from Maven Central, compiles the
reader and the independent Java assertions, generates XML through OC's actual
emitter, and deserializes it. It leaves no Java dependency in OC packages.
Upstream compiler deprecation warnings and SLF4J's absent-binding notice are
expected. Normal Node/PostGIS regression suites do not require Java or network.

This qualifies that pinned reader, not every navigation application's current
TraFF support, Android transport or graphical viewer behavior. The protocol
references are the [TraFF 0.8 specification](https://gitlab.com/traffxml/traff/-/tree/3478924d974563e6318e1e9680413c233692d360)
and [TraFF Viewer's single-response URL reader](https://gitlab.com/traffxml/traff-viewer/-/blob/8037388a280f18c5a3dc48ec39a9e2821e70ee09/src/main/java/org/traffxml/viewer/input/StaticSource.java).
