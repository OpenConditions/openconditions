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
information. Vehicle-specific and incomplete restrictions remain withheld.

Locations of effects with their own geometry are still emitted as separate
messages. This change does not provide full geometry fidelity: lines use
endpoints, and the existing projection reduces other geometries to a point.
It does not establish a road-matched geometry or routing eligibility.

The Java `libtraff` reader uses a second-resolution ISO timestamp parser.
Receive/update/expiration/start/end times are normalized to UTC with fractional
seconds truncated on this wire projection. Stored canonical timestamps keep
their original precision. XML escaping remains the XML builder's responsibility.

## Delay durations

Delay effects export `q_duration="hours:minutes"` alongside any queue `length`
in metres. Canonical delay seconds are rounded to the nearest whole minute
(30 seconds rounds upward); the inspector reports `field_precision_reduced`
when that changes the value. A positive delay below 30 seconds is omitted rather
than exported as zero. Invalid, negative or unrepresentably large durations are
also omitted with `field_not_exported`; queue length can still travel. An exact
zero is representable as `0:00`. Canonical records retain their original seconds.

Distinct duration/queue pairs remain separate events within their message;
they are neither summed nor combined across effects. Exact duplicate pairs are
collapsed. Each effect's location, validity and applicability still govern export.

The pinned Java reader **accepts but discards `q_duration`**: its deserializing
constructor leaves duration parsing unimplemented. The independent check verifies
the emitted duration attributes with the JDK XML parser, then verifies reader
acceptance and preservation of event count and queue length. It does not claim
that this reader can display the delay duration.

## Independent reader check

The optional check exercises the actual upstream `TraffFeed.read` with emitted
bidirectional points/lines, canonical fractional/offset timestamps, empty and
withheld feeds, and 5,001 distinct messages:

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
