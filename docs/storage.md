# How OpenConditions stores records

The model's records ([`model.md`](model.md)) live in the Postgres schema
`conditions`. One table family holds each record class. Every write goes
through the write seam (`sealRecord`) in `@openconditions/storage`; reads go
through `@openconditions/core` and `@openconditions/core/server` (see
[Read API](#read-api)).

## Record tables

`situation`, `feature` and `offer` keep one row per record. The row's `record`
column is the stored record itself, and the only thing a read returns. The other
columns are promoted from it for filters, joins and indexes, and the writer
derives them all through one projection:

- id, canonical id, kind, type, subtype, domain, temporality;
- source, origin, access mode, privacy class, instance;
- revision, record time, content hash, fetch time, expiry;
- geometry and country;
- the tombstone.

A situation's evidence summary is materialised in columns of its own, and a read
merges it back as `evidence`.

Each record also has child rows, re-materialised whenever the record changes:

- `situation_effect`: every effect of a situation, a roadworks phase's included,
  with the validity it applies for and its geometry.
- `feature_component`: a feature's components. They also ride inside the
  feature's `record`.
- `record_relation`: every record's relations, so "what points at this record" is
  an index lookup.

`feature_link` and `feature_canonical` hold identity links and the canonical view
(the linking layer in [`model.md`](model.md#identity-linking)).

`source` mirrors the loaded feed catalogue (tier, access mode, licence, rights,
extras allow-list, lane numbering) and is refreshed at every boot. A source no
longer loaded stays, inactive, because its records still name it.

## Revisions and lifecycle

A poll is written by `writeSnapshot`, in one transaction under the source's
advisory lock; an event feed's poll calls `writeSnapshotIn` inside its own
transaction, so the source's poll status commits with its records. Each record
ends up in one of these states:

- **Unchanged.** The draft's content hash equals the stored one. Nothing is
  validated or written; the source's poll time says it was seen again.
- **New, changed or returning.** The draft is sealed with the next revision and
  stored, and a `*_revision` row records the
  [change kinds](model.md#change-kinds). A returning record is one tombstoned earlier that
  the source publishes again; it gets `created`.
- **Withdrawn.** A record a complete snapshot no longer holds is tombstoned
  `withdrawn`: a new revision carrying the tombstone. Its effects and relations
  are removed. A snapshot the shrink tripwire
  (`OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO`, by default only a drop to nothing)
  calls suspect is not published, until three consecutive complete polls, ten
  minutes or more apart from first to last, have stated the smaller set
  (`source_shrink`); a publication or a not-modified answer starts the count
  over.
- **Rejected.** A draft that fails validation is counted and logged. The poll
  goes on, and the stored version stays.

Every new situation revision, a tombstone included, queues the situation's graph
binding in `binding_queue` in the same transaction
([graph binding](graph-binding.md)). A purged record's bindings and queued work
go with it.

`writeRecord` writes one record the same way: a crowd report it seals, or a
peer's record it keeps with the peer's revision, ignoring one that is not newer
and never writing over a record another instance wrote under the same id (two
instances that ingest one feed mint the same ids, and each keeps its own).
The other way round, a draft written here — a poll or a report — takes over a
peer's copy of the same id even when the content is the same: it is sealed
anew as this instance's own, so it is journalled to this instance's
subscribers and the peer's later revisions and retraction no longer reach it.
A peer's copy ended here — expired by the sweep, withdrawn by a poll, rejected
by a reviewer, superseded by a merge, erased — keeps the peer's revision and
takes no history row, so the peer's next revision is never mistaken for a stale
one: it restores an expired or withdrawn copy, while a rejected or superseded
copy stays ended. An expired copy also comes back when the peer moves its
lifetime at the same revision (a crowd report's new evidence) to one not yet
over; that revision keeps its one history row. The peer's own retraction is
the peer's next revision.

A crowd situation's evidence summary lives in its own columns
(`evidence_state`, `confidence_score`, `routing_eligible`, `corroborations`,
`flagged_at`), recomputed from the `report_evidence` ledger by the
contributions service; its lifetime is the evidence's, so the recompute also
moves `expires_at` and `freshness.expiresAt` in place, without a revision.

Every change of one of this instance's own records — a new revision, a crowd
report's new evidence, a tombstone — is journalled in `federation_outbox` by a
trigger on the record tables, in the same transaction, while a subscription
wants the class (observations: only for a subscription naming the property). A
peer's record (it carries an origin chain), an on-demand answer, a fused row
and a record of a restricted source are never journalled.

A change-only reading is journalled only when it changes, so a peer holding a
quiet source's readings cannot tell a source still polled from one gone. A
successful poll of a public bulk source therefore journals a `liveness` entry
(`journalSourceLiveness`, from the poll status write, in the publication's
transaction after its changes), at most one per source every ten minutes, while
a subscription admitting observations sets `sourceLiveness: true` in its
filter (a pull asks with `sourceLiveness=true`). Only such a subscriber is
served them, of the domains its filter names; a source turned restricted has
its liveness withheld. A receiving inbox notes the source as received from the
peer when the peer polled it, never later than now, so the peer's readings of
it hold by the same window as the peer's own (see
[validity](model.md#registry)). An instance that predates the entry type
ignores the filter field and the query parameter, and its subscribers never
ask for it: neither side is served an entry it does not read.

Since the capture journals only while a subscription wants a record, a record
stored before that (or whose entries were pruned) would reach a subscriber
only once it next changed: a long-lived feature perhaps never. The federation
service therefore seeds the journal (`seedFederation`) at boot and whenever a
peer creates or changes a subscription: each live record and series' current
reading the outbox may carry and a subscription wants, whose latest entry is
not a change, is journalled as a create, as for a source turned public. A
second run journals nothing; a source whose lock a long poll holds is retried
later.

`conditions.source` also records the `restricted` flag the outbox last
reflected for each source (`federation_restricted`). When a boot's catalogue
sync flips it, the ingest service reconciles the outbox in the background, a
page of one source's records per transaction under the source's lock:

- **Turned restricted:** a delete is journalled for each record a peer may
  hold (see below), so subscribers end their copies. A live record's reason is
  `withdrawn`; an ended one's is its own. A reading gets none, because
  subscribers keep no tombstone of an observation.
- **Turned public:** a create is journalled for each live record, and for each
  series' current reading, exactly as the trigger writes it.

The first page marks the source pending (`federation_pending`). The
transaction of its last page updates its basis and clears the mark. A
reconcile that is stopped or fails resumes at the next boot: a record whose
latest entry already says what the flag asks is skipped. A pending source is
reconciled toward its current flag even when a flip back made its basis match
again, so records retracted before the flip back are re-journalled. Meanwhile
the outbox read withholds every change of a now-restricted source. It still
serves the source's deletes.

A peer may hold a record of a now-restricted source when the record has
journal entries, or when a subscription wants its class and the record was
stored (`created_at`) by the time its source last turned restricted
(`restricted_since`, set by the catalogue sync). The second case covers a
long-lived record whose entries were pruned. A record stored after that,
including one a poll writes while the reconcile runs, never reached a peer.
Neither did any record of a source that was restricted when it was added.
Nothing of such a record is journalled, not even a delete.

An erasure (`rights_revoked`) of a restricted source's own record that a peer
may hold still removes the record's earlier changes from the journal. It also
journals the delete, so a subscriber erases its copy.

A source added after the column was introduced starts with no basis. It has
nothing journalled to correct, so it is taken as in sync with its flag.

The sweep, every five minutes, takes these actions:

| What                                                                 | Action                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| A record whose `freshness.expiresAt` has passed                      | Tombstoned `expired`                                          |
| A feed record of a source with no successful poll for an hour        | Tombstoned `expired`                                          |
| A record tombstoned more than `OPENCONDITIONS_HISTORY_DAYS` (90) ago | Purged with its revisions, bindings, crowd evidence and votes |
| An on-demand row at expiry                                           | Deleted (it was a cache, with no history)                     |
| A series of a transient property past its reading's expiry           | Deleted, bulk or on demand (nothing else ends it)             |

A declared validity end is never a tombstone reason: a source that still
publishes an ended record keeps it, and reads filter by time. A source whose
lock stays held past the sweep's `lock_timeout` (a long publication) is left
to the next sweep and counted as `busy`.

## Observations

`observation_latest` is the series registry: one row per subject, property,
qualifiers and source, holding the reading in effect now. A flow source
rewrites tens of thousands of these rows a minute, so a row stays small and
its update stays heap-only (HOT):

- `reading` is the stored record minus its series template (`readingOf`); the
  record is `conditions.observation_record(template, reading)` in SQL,
  `recordOf` in code.
- `template` is stored out of line and written only when `template_hash`
  changes; an update that keeps it carries a pointer.
- Nothing indexes what a quantity reading without an expiry changes (every
  flow reading): a crowd row's record id has its own column,
  `crowd_record_id`, rather than an index over `reading`. The table keeps half
  of each page free (`fillfactor = 50`) for the next version of its rows.
  Category and boolean series (`value_text`) and series with an expiry
  (`expires_at`) are indexed by what they change, and change far less often.
- `effective_from` is indexed with BRIN: a btree would stop HOT updates.

The history is `observation`, compact by design: about 110 bytes a reading,
where a sealed record is about 1.2 KB. A row holds only what varies between
readings:

- times;
- statistic;
- value;
- quality and baseline;
- the poll it came from, and its payload's position in that poll.

What every reading of a series shares (subject, location, publisher) is the
series' `template`. A read rebuilds the stored record from series plus row.
Instants read back in UTC.

A property's registry `retention` decides what is kept:

| `retention`        | History kept                       |
| ------------------ | ---------------------------------- |
| Default            | Every reading                      |
| `changeOnly`       | Only readings whose result differs |
| `latestOnly`       | None                               |
| On-demand readings | None                               |

`componentHistory: false` keeps no history of readings about a component (a
lane or vehicle-class channel of a measurement site): they update their latest
row only, and the site's own series carries the history.

A `transient` property (`fire.frp`: one satellite detection at a place) holds
one reading of one instant per series. Its readings skip the comparison with
the source's stored series: each is inserted with its history row, a reading
the series already holds (a poll restating the last day's file) writes
nothing, a later reading at the same key (a newer detection at the same pixel
position) updates the series to that reading, and the sweep deletes the series
once its reading's expiry passes.

History is partitioned by retention class (a property's `rawDays`, 0 for
keep-everything), then by day (by month for keep-everything). Retention drops
whole partitions: a day goes an hour after its last reading is `rawDays` old,
so a class keeps between `rawDays` and `rawDays + 1` days. The ingest service
creates partitions 16 days ahead and drops expired ones hourly; a day of a
class holding a rolled-up property is dropped
only once the rollup has finalized past it (or when it holds no reading). A
reading no partition holds is counted and kept out of history; it still
updates the latest row. A changed reading of the instant in effect corrects
the latest row.

Rollups:

- **Hourly** (`observation_rollup_hourly`): count, minimum, maximum and mean, and
  for `traffic.speed` a 2 km/h histogram (percentiles do not decompose;
  histograms do). Kept 35 days.
- **Daily** (`observation_rollup_daily`): for slow series such as fuel prices.
  Kept 400 days.

A period is rolled up six hours after it ends. A reading that arrives later
stays in the history but never reaches the rollup; a write counts it
(`pastRollup`).

A poll holds at most 100 000 records of one class (`MAX_ROWS_PER_SOURCE`) and at
most 1 000 000 readings (`OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL`): a national
flow feed sends a speed and a volume per site plus a reading per lane or vehicle
class. A larger poll is refused whole, keeping the last good publication.

### History budget

Measured on NDW's own payloads (19 000 sites, a poll a minute): a poll writes
about 10 800 site speeds and 19 000 site volumes to history and moves about
141 000 latest rows (sites, lanes and vehicle classes); a history row takes
about 185 bytes with its primary-key index. A steady poll takes about 25 s
(laptop, PostGIS in a container). At the default retention, a class keeps on
average half a day more than `rawDays`:

| NDW series                              | Kept                        | Size            |
| --------------------------------------- | --------------------------- | --------------- |
| `traffic.speed`, per site               | 2 days (`rawDays: 2`)       | about 7 GB      |
| `traffic.volume`, per site              | 1 day                       | about 8 GB      |
| Lane and vehicle-class channel readings | latest row only, no history | none            |
| `observation_latest`                    | one row a series            | about 0.6 GB    |
| Hourly rollups                          | 35 days                     | well under 1 GB |

NDW is the largest flow source by far; all 24 flow feeds together come to
roughly 20 GB of history. Minute-level history of every site's speed and volume
is what that buys; the hourly rollups keep the long tail for baselines and
profiles. Measure against captured payloads before raising a property's
`rawDays`: a day of NDW volumes is about 5 GB.

## Read API

The ingest service's public routes read through `@openconditions/core`
(Apache-2.0, so OpenMapX's bridge can use the same readers); every record
leaves through the licence egress of `@openconditions/publishers`: a
share-alike record is withheld and a crowd reporter's key is stripped.

| Route                                      | Reader                                            | Reads                                                                 |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| `/situations` (`.geojson`, `.jsonld`, XML) | `listSituations`                                  | `situation`, `situation_effect` for a box                             |
| `/situations/{id}`                         | `readRecord`                                      | `situation`, `record_binding`                                         |
| `/features` (`.geojson`, `.jsonld`)        | `listFeatures`                                    | `feature`                                                             |
| `/features?canonical=1`                    | `listCanonicalFeatures`, `canonicalFeatureRecord` | `feature_canonical` and its members in `feature`                      |
| `/features/{id}`                           | `readRecord`, `readCanonical`                     | `feature`, `feature_canonical`                                        |
| `/offers`, `/offers/{id}`                  | `listOffers`, `readRecord`                        | `offer`                                                               |
| `/observations/latest`                     | `listLatestObservations`                          | `observation_latest`                                                  |
| `/observations/grid`                       | `readGrid`                                        | `observation_latest`                                                  |
| `/observations`                            | `readSeries`                                      | `observation_latest`, then `observation` or a rollup table            |
| `/history/{class}/{id}`                    | `readRevisions`                                   | `situation_revision`, `feature_revision`, `offer_revision`            |
| `/coverage`                                | `readCoverage`                                    | the class tables, `observation_latest` with `source`, `source_status` |

Collections are pages of one statement each, keyed by a cursor: situations,
features and offers by id, canonical features by canonical id, latest readings
by series id. A series keeps its id for life while its reading (and so the
record id) moves on with every poll, so a walk over latest readings never
returns a series twice and never skips one that exists throughout it. A record
or reading that changes mid-walk may appear in either state.

The [TraFF export](traff.md) instead walks its internal pages in one read-only
repeatable-read transaction and returns a complete feed, or 413 if its 20,000
candidate-situation or 32 MiB XML bound is exceeded. No successful response is
truncated, and cursor/limit are rejected. Other collection and DATEX II routes
retain their paging contracts.

**Situation deduplication.** `dedupe=1` is a conservative display fold of
compatible reports from different source IDs. It preserves distinct directions,
restrictions, extents and validity; uncertain reports remain separate. It does
not fold after requested geometry simplification. See the
[matching contract](situation-deduplication.md) for eligibility and page limits.

**Canonical view.** `canonical=1` on `/features` serves one feature per cluster
of `feature_canonical`, a lone feature's cluster included. The record is the
survivor's under the cluster's canonical id (the id fused and crowd readings
name as their subject), with the canonical component set (the members'
components, keyed as the canonical view keys them), the other members credited
in `provenance.mergedSources` and every member listed in
`provenance.derivedFrom`. It is built from the members the egress lets out, so
a share-alike member lends it neither components nor credit, and a withheld
survivor is replaced by the next member. A cluster matches a filter when one of
its live members does. `/features/{id}` with a member id adds the cluster's
summary; with a canonical id it serves the canonical feature.

**Fused readings.** `/observations/latest` serves per-source and crowd rows by
default and no fused row. `canonical=1` serves the fused row of every
fusable property (one a linkable feature kind carries, or the crowd reports)
and the per-source rows of the rest (traffic readings, which never link). The
operator reads `@fused`, the fusion of every source. The public scope reads a
fusion of public contributors only: the `@fused` row when all its contributors
are public (`fused_public`), else the `@fused-public` row fused from the
public ones, and no fused row when none is public. A public fused row sits
where a public member puts the feature (the winner's, else the survivor, else
the first public member); a crowd-won fusion with no public member to sit at
has no public row. A fused row credits its contributors in
`provenance.mergedSources` and carries the most restrictive of their rights; a
share-alike winner withholds it. A crowd reading carries its evidence summary;
one expired or negated is no longer listed.

`conditions.source` records the `restricted` flag, tier and licence registry
classification (a hash of each licence's id, redistribution grant and
share-alike flag) each source's fusions were last refreshed under
(`fusion_restricted`, `fusion_tier`, `fusion_licenses`). When a boot's
catalogue sync changes the first two, or a release reclassifies a licence
(every source then), the fused rows of every canonical feature that source
has a fusable reading on were fused under the old rule.
The ingest service refreshes them in the background, in batches of canonical
features, one transaction each under the features' fusion locks, and logs its
progress. A source's basis is updated in the transaction of the batch holding
its last canonical feature, so a refresh that is stopped or fails resumes at
the next boot and a finished one is not repeated. Until a feature's batch
commits, the public scope withholds a fused row any now-restricted source
contributed to (its `fused_from`), and a now-unrestricted source has not yet
joined the public fusion.

The first boot after the migrations that add these columns finds every source
outdated and re-fuses every canonical feature once, in the background. Until
it finishes, public canonical reads serve no fused reading for a feature not
yet refreshed (its members' readings remain, through the feature read's
`expand`). A canonical feature only crowd readings fuse on is refreshed by its
next crowd write.

**Series.** `/observations` names one series by subject (a subject key, or a
record id plus `component`), property, qualifiers (a JSON object) and, where
several sources report on one subject, `source`. It reads raw readings while
`from` is within the property's `rawDays` (or the property keeps raw readings
for good), its hourly or daily rollup beyond that, or what `resolution` asks
for; one read is one resolution. Raw readings come back as the records they
were written from; rollups as periods with count, minimum, maximum, mean, the
unit and, for speeds, the histogram. Fused rows, channel readings
(`componentHistory: false`) and `latestOnly` properties keep no history, so a
series read of them is empty.

## Raw payloads

Every decoded response a poll receives is archived once per source, as a zstd
blob on disk indexed in `raw_payload`. The poll's attempt row is opened before
anything is fetched, and its id is the fetch id the payloads are filed under. A
response already held is only counted again.

A source's `rights.retention` decides how long:

| `rights.retention` | Kept                   |
| ------------------ | ---------------------- |
| `false`            | Nothing                |
| Unset              | The last 48 hours      |
| `true`             | Its tier's full window |

The tiers:

| Tier                            | Every payload for | Then one an hour for | Always kept         |
| ------------------------------- | ----------------- | -------------------- | ------------------- |
| Situation feeds                 | 48 h              | 14 days              | Newest 3 per source |
| Flow feeds                      | 48 h              | 7 days               | Newest 3 per source |
| Site tables, station registries | —                 | —                    | Newest 3 per source |

Pinned payloads, and the payloads of each source's latest published poll (what
is live now was read from), are never evicted. Nor is the newest payload of
each URL a source fetched, which a poll may still read from what it holds: a
site table's however old, a feed's within its tier's thinned window. A source
kept for 48 hours only keeps nothing longer for this.

Over `OPENCONDITIONS_RAW_MAX_BYTES` (10 GiB), eviction climbs a ladder, each rung
only while still over the cap:

1. Shorten the thinned windows a day at a time, flow before situations, down to
   one day past the hot window.
2. Thin further, to one payload per 6 hours, then per day.
3. Cut into the hot window, flow first.

Only rung 3 warns: it sets `source_status.raw_hot_evicted_at`. Eviction deletes
the blob and keeps the index row, so a raw reference still names its payload.
Index rows evicted longer ago than the history window are removed. Where a
second ingest process polls some feeds, each process archives its feeds'
payloads under its own directory and evicts, and caps, the blobs in that
directory, weighing each source's payloads together wherever they lie
([A second ingest process](../services/ingest/README.md#a-second-ingest-process)).
Settings and the `raw` command are in the [ingest README](../services/ingest/README.md#raw-payloads).

### Replay

The archive exists so a parser change can be checked against what feeds really
sent:

```sh
pnpm --filter @openconditions/ingest raw replay <source> --from <time> [--to <time>]
```

For each published poll of the source in the window, replay reads the poll's
archived payloads, parses them with the current parser (dated by the poll's
attempt time, OpenLR resolved through the configured resolver) and compares the
drafts, by content hash, with the situations that poll left stored: each
situation's latest revision recorded before the next attempt began, unless that
revision is a tombstone. It prints one line per poll —
`N same, N changed, N new, N gone`, plus `N unplaced` when OpenLR could not
place a draft — followed by the ids that changed, are new or are gone. A poll
whose payloads were evicted is listed with the count of missing payloads and not
compared. Replay writes nothing. It covers event feeds only; a flow feed is
refused.

### Exact fire-density cell suppliers

`GET /observations/grid` preserves its `cells` numeric tuples
`[longitude, latitude, count, sum, max]` and its native collection `sources`.
The additive `cell_contributors` array is sorted in the same cell order and contains
`{ longitude, latitude, native_sources, sources?, contributors?, lineage_complete }`
for each cell. `native_sources` contains only admitted native feed IDs counted in
that cell, for source-policy filtering. Its `sources` are
canonical parent display IDs and `contributors` are captured display credits in
the format documented in [speed coverage](speed-coverage.md#selected-display-contributors),
including required notices in the captured scoped licensing. Distinct captured
credits may share a source ID.

The acquisition writer captures versioned content-addressed receipts outside
canonical record bodies; an unchanged input keeps its original receipt. Grid
aggregation joins those pointers after grouping, without recursive catalogue
lookups per reading. Known receipts remain visible in a mixed known/unknown cell
with `lineage_complete: false`; wholly unknown cells omit canonical `sources` and
`contributors`. Native cell IDs and numeric tuples remain available.

Counts, sums, maxima and credits come from the same grouped database snapshot.
Only groups admitted by public scope and licence egress enter the cell's lineage.
A consumer credits each displayed density cell's suppliers rather than every source
counted elsewhere in the collection. Clients of an older producer can retain their
existing numeric tuple parsing; missing cell metadata does not prove a cell's exact
suppliers.

### Captured credits on expanded readings

Every reading in `expand=latest` includes `provenance`, a captured credit snapshot
with `sourceId`, `attribution`, optional `upstream`, and optional `mergedSources`.
Each merged source contains only `source`, `recordId`, `attribution` and optional
`upstream`. The snapshot is copied from the selected observation after public
egress, independently of the feature's own credits or current catalogue metadata.
It contains no reporter, raw reference, origin chain, private evidence or payload.
A fused reading retains every contributing publisher's upstream chain.
`contributors: string[]` continues to identify native sources for selection; it is
not historical licensing evidence.

Numeric dictionary receipts likewise capture the selected observation's attribution
and complete upstream chain. Receipt format v2 is internal; public grid/flow
lineage wire versions are unchanged. Earlier lossy dictionary versions are treated
as unknown rather than complete, retaining numeric values without inventing credits.
New receipt identity includes upstream changes, and credit
projection does not borrow current catalogue names, URLs, publishers or notices.
Notices captured in scoped `licensing` travel with their original receipt. Existing
receipt rows are immutable; this change does not reconstruct missing old lineage.

### Readings by stated confidence

`/observations/latest` and `/observations/grid` take `minConfidence` (`low`,
`nominal` or `high`) and leave out every reading whose `quality` states a lower
class, in the same statement, so a grid cell counts, sums and credits only the
readings kept. A `quality.confidence` fraction is classed as FIRMS classes MODIS
percentages: below 0.3 low, below 0.8 nominal, else high. A
`quality.supplierCode` of `low`, `nominal` or `high` (or `l`, `n`, `h`, as VIIRS
writes them) is its own class. A reading that states neither is kept, and `low`
leaves out nothing. `minConfidence=nominal` drops the low-confidence fire
detections of both instruments. An instance older than the parameter answers it
400, as it does any query key it does not know.
