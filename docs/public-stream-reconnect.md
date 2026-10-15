# Public stream reconnect investigation and decision

Evaluated 2026-10-15 against OpenConditions
`2bbfe58fa1785eaf33670a424d72b6f12bf155c3` and the current local OpenMapX
consumer source. This is a scoped public-situations SSE investigation, not a
production-load audit or a federation conformance review.

## Decision

**Defer durable public replay. Document and test the current reconnect contract
now.** There is no identified consuming application whose requirements justify
adding a public journal, cursor retention, visibility history and snapshot/replay
coordination. The reference consumer, OpenMapX, uses paged JSON reads. That is
repository evidence, not proof that nobody outside these repositories uses SSE.

The immediate deliverable is a reproducible benchmark, real HTTP/PostGIS lifecycle
tests, and clear consumer guidance. Production stream behavior stays unchanged.
The more ambitious snapshot protocol below is a reviewed design proposal, not
an implemented or accepted API. Neither that protocol nor durable replay should
be enabled until a named consumer can implement and validate its lifecycle.

## What exists

- [`record-stream.ts`](../services/ingest/src/record-stream.ts) holds one previous
  ID/signature map **per connection**, polls only after the preceding write has
  finished, respects socket drain, and disconnects a stalled writer after its
  write deadline. Read failures retain the previous map and retry; they do not
  turn an error into an empty authoritative snapshot.
- [`sse.ts`](../packages/publishers/src/sse.ts) diffs content hashes and evidence,
  emits complete changed records and ID-only removals. Every new connection
  starts with an empty map and emits its current matching records again.
- [`routes.ts`](../services/ingest/src/api/routes.ts) reads public situations on
  each poll, pages at 5,000, silently truncates at 20,000 emitted records, and
  defaults to 100 simultaneous connections. Polls default to 15 seconds **after**
  the preceding read/write cycle; this is not a 15-second delivery guarantee.
  There is no atomic database snapshot spanning those pages, byte cap on the
  full stream snapshot, initial-completion marker, or durable reconnect state.
- `Last-Event-ID` is ignored. Upsert `id:` values identify records, not journal
  positions; removal frames have no event ID. The same ID can recur for several
  revisions. The query rejects `cursor`, so a record ID cannot be used as an
  undocumented paging/replay cursor.
- Source restriction, current licences/upstream licences, reporter stripping,
  current validity and expiry, and query membership are evaluated by the existing
  public read/egress path. An operator token does not widen this public stream.

The [WHATWG EventSource specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header)
defines automatic reconnection and the `Last-Event-ID` request header. It does
not supply an application's missing replay log. Its
[processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#processing-model-10)
announces `open` for a successful connection before processing its event stream.

## Consumer and demand evidence

OpenMapX's `integrations/openconditions/client.ts` exposes `get`/`getOptional` JSON
requests. `road-conditions/provider.ts` pages `/situations` and obtains routing
evidence separately; `features/read.ts` pages `/features`. There is no public
OpenConditions SSE subscription in either inspected repository. An unrelated
OpenMapX administration-job EventSource is not a traffic-data consumer.
Read-only GitHub issue searches for stream/reconnect returned no matching
OpenConditions issues; this is a limited demand signal, not adoption telemetry.

Switching OpenMapX to this stream would be an additional consumer project. Public
SSE covers situations only; it does not replace operator-scope reads, graph
binding evidence, flow, feature or observation APIs. Transported situation
records alone never establish routing eligibility.

No production request logs, reconnect distribution, WAN behavior, running-image
revision, external-client inventory or actual provider load were measured.

## Reconnect measurements

The committed development probe is
[`bench-public-stream.integration.ts`](../services/ingest/src/__tests__/bench-public-stream.integration.ts).
It starts disposable PostGIS, applies current migrations, stores one synthetic
closure through the normal writer, replicates its materialized row for load,
and uses the real HTTP `/stream` route. Point and 32-position curved-line records
share the same canonical metadata. Replicated fixture hashes/effect IDs are not
an ingestion benchmark. The probe never reads `DATABASE_URL` or production data.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @openconditions/ingest exec tsx src/__tests__/bench-public-stream.integration.ts \
  > /tmp/public-stream-benchmark.log
sed -n 's/^BENCHMARK_RESULT=//p' /tmp/public-stream-benchmark.log | jq .
```

One initial delivery and one immediate reconnect were sampled per case on
Node 24.18.0, macOS arm64, local `postgis/postgis:16-3.4`, without WAN, TLS,
compression, concurrent writers or artificial socket stalls. The reconnect
supplies the event ID actually received at the end of the initial delivery.
Times include the local client receiving/parsing frames; these individual samples
are illustrations, not latency percentiles, capacity limits or production SLOs.
Bytes are raw UTF-8 SSE response-body bytes; MB below means decimal MB.

| Geometry    | Matching rows | Records received per connection | Body MB per connection | SELECT pages per connection | Initial / reconnect completion ms |
| ----------- | ------------: | ------------------------------: | ---------------------: | --------------------------: | --------------------------------: |
| Point       |           500 |                             500 |                  0.639 |                           1 |                           48 / 24 |
| Point       |         5,000 |                           5,000 |                  6.395 |                           1 |                         184 / 136 |
| Point       |        20,000 |                          20,000 |                 25.580 |                           4 |                         715 / 672 |
| Point       |        20,001 |                          20,000 |                 25.580 |                           4 |                         688 / 698 |
| Curved line |           500 |                             500 |                  1.099 |                           1 |                           31 / 27 |
| Curved line |         5,000 |                           5,000 |                 10.990 |                           1 |                         270 / 283 |
| Curved line |        20,000 |                          20,000 |                 43.960 |                           4 |                     1,379 / 1,361 |
| Curved line |        20,001 |                          20,000 |                 43.960 |                           4 |                     1,365 / 1,310 |

Reconnect and initial bodies were exactly the same byte length in every pair.
The 20,001-row cases demonstrate truncation, not complete delivery. A client
cannot discover this extra row from the stream's wire protocol. The probe knows
the seeded row count; its stopping condition is not a server completion signal.

At an ideal 10 Mbit/s, 25.58–43.96 MB alone takes approximately 20.5–35.2 seconds
before latency and protocol overhead. That is arithmetic, not measured mobile
performance. Large unfiltered snapshots can therefore justify future optimization,
but a hypothetical large client is insufficient evidence for durable replay now.

Every **unchanged steady poll** still rereads the current result and transfers it
from the database to the service; only the socket output becomes a heartbeat.
For illustration, 100 connections each matching 20,000 eligible rows imply about
400 page SELECTs per poll cycle and two million decoded records across the
connections. The cycle takes longer than 15 seconds when processing does. This
is a structural extrapolation, not a measured 100-client throughput result.
A replay transport layered over the same polling loop would not remove that
cost. Narrower filters or shared query polling may be the better next optimization
once a workload exists.

## Lifecycle evidence and current consumer contract

The real API integration suite now exercises cancellation, bbox departure,
licence withdrawal, expiry, unchanged retained records, and newly entering records:

- A continuously connected client receives four removals and the new situation.
- A disconnected client reconnects with `Last-Event-ID`; the server sends the
  two currently matching situations, including the unchanged retained situation.
  It does not know the disconnected client's previous membership and cannot emit
  removals for its four old records.
- Clearing the connection's result map before applying that replacement view
  converges to the same two IDs. Keeping the previous map and applying only the
  new upserts would leave the four obsolete IDs behind.

**For the existing endpoint, treat every successful connection—including every
EventSource `open` after reconnect—as a new replacement view.** Clear that
subscription's old IDs before applying events; upsert `situation` records by
`data.id` and delete `remove` records by `data.id`. Recreate the subscription and
its state whenever filters or endpoint change. Never use these record event IDs
as replay acknowledgements. Scope clearing to this subscription, not an
application-wide cache shared by unrelated queries.

A successful `open` is not proof that the first database read succeeded, that
all matching rows were delivered, or that the view is complete. The initial
read can fail and retry; a disconnect can interrupt a snapshot. There is no
completion event. Do not treat the first record, heartbeat, HTTP 200, or the
20,000-record ceiling as certification of a complete authoritative dataset.
Surface reconnect/loading/stale state as appropriate. For complete collections,
use explicit paged reads and evaluate their pagination consistency requirements.
For navigation, continue using the separate routing-evidence contract.

An empty replacement view is valid: clear on connection open even if no situation
arrives. This follows from the contract; it does not invent a deletion event
for each previously seen ID. The empty-reconnect integration test verifies that
the first frame after an offline withdrawal is a heartbeat, not invented
per-record removals. During a network outage no transport can tell a
client about new cancellations or rights changes; stale local state must not be
presented as freshly validated data.

## Options evaluated

| Option                                    | Benefit                                                                                  | Cost and limits                                                                                                                   | Decision                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Existing stream, documented reset on open | Correct eventual replacement for a consumer that clears old IDs; no server/API migration | Full reconnect bodies; no atomic completion; existing cap/paging limitations                                                      | Ship guidance, benchmark and lifecycle tests                 |
| Explicit bounded snapshot protocol        | Staged replacement, empty-snapshot completion, detectable failure/truncation             | Requires a consumer to adopt new events and cap behavior; still full polling/reconnect                                            | Concrete design below; defer implementation pending adoption |
| Bounded in-process replay cache           | Can save short reconnect transfers                                                       | Lost on restart; query/epoch/policy invalidation, cache bytes and expiry still required; does not solve database polling          | Defer until short-outage workload demonstrates value         |
| Durable public replay journal             | Survives process restart and can deliver missed transitions within retention             | New complete capture, membership history/time events, visibility/erasure, ordering/barriers, retention and client state machinery | No-go with current demand evidence                           |
| Authenticated federation subscription     | Existing cursor/backfill/retraction foundation for approved replication peers            | Different scope, capture, filters, tier and privacy contract                                                                      | Use for its intended peer replication purpose                |

## Concrete snapshot design spike: future protocol 2

This section intentionally specifies a bounded **replacement-snapshot** protocol,
not historical replay. It is an implementation candidate for a consumer-backed
follow-up. The current endpoint does not accept `protocol=2`.

1. Opt in with `GET /stream?protocol=2` and the existing public filters. Legacy
   clients keep their existing wire behavior. Unknown protocol versions fail
   validation; filters identify a distinct result set.
2. Before opening the initial response, read matching candidates at one evaluation
   instant in a repeatable-read, read-only transaction. Bound candidates at 20,000
   **before** public egress filtering, to bound work even if many candidates are
   withheld. Apply the real public egress; never replay revoked old payloads.
3. Bound the entire framed initial snapshot to 32 MiB UTF-8 bytes, including
   control frames. If either bound is exceeded, return HTTP 413 before any SSE
   data and instruct the client to narrow filters. A read failure before headers
   produces an HTTP error, not a successful empty snapshot. Finish the database
   transaction before writing to a slow socket.
4. Send `id:` with an empty value and `event: snapshot-start` carrying
   `{ "version": 2, "at": "<evaluation instant>" }`. Empty ID clears the browser's
   old SSE ID. Follow with existing `situation` data records, without cursor IDs,
   then `event: snapshot-end` carrying `{ "count": N }`, including zero.
5. On start, invalidate the old view and stage an empty map. Commit it only on end,
   after checking count. A disconnect/error before end discards the staging map;
   it must not become an authoritative partial replacement. The client marks the
   view unavailable/stale until a new completed snapshot arrives.
6. Continue existing situation/remove diffs after completion, with no durable
   cursor or claim of historical delivery. Snapshot completion certifies the
   initial bounded view at its stated instant, not future wall-clock freshness
   or the delivery of every transient state between polls.
7. On a later read failure, retain the server's last successful diff baseline and
   retry, as today. If a later snapshot exceeds a bound, send a terminal
   `event: reset-required` with `{ "reason": "snapshot_too_large" }`, close, and
   require narrower filters before reopening. A native EventSource client calls
   `close()` on this event to stop automatic reconnection, invalidates its view,
   and creates a new subscription only after the filters are narrowed. It must
   not treat a truncated set as authoritative.
8. Preserve serial reads, backpressure/deadline handling, connection caps and
   shutdown cleanup. No authentication expansion, journal writes, cross-client
   cache or retained historical payloads belongs in this protocol.

The implementation would need tests for zero rows, exactly-at/over both limits,
concurrent page mutations under repeatable-read, failure before headers, drop
before end, slow drains during initial frames, server restart, policy withdrawal,
and a later over-limit result. It must be adopted and exercised by a real client;
server tests alone do not establish client correctness.

## Why federation replay is not a shortcut

The audited capture in
[`0062_federation_capture.sql`](../packages/core/drizzle/0062_federation_capture.sql)
is subscriber-gated and deliberately omits ordinary feed expiry extensions when
revision/evidence do not change; earlier capture excludes peer/on-demand records.
Public SSE does not create a federation subscription. Therefore its current
visible situations are not guaranteed to be present in that journal.

[`outbox.ts`](../packages/federation/src/outbox.ts) correctly uses `(txid, seq)`
ordering with an xmin fence rather than treating a bigserial maximum as a safe
commit frontier. That primitive is worth reusing in a future design, but a
separately read snapshot is not automatically aligned with that frontier.
Taking a snapshot and a maximum sequence can skip in-flight commits; replaying
from an older frontier can overwrite a newer snapshot state with older content.
A proper shared visibility barrier and revision/membership rules must be designed
and tested. The fence can also wait behind old open transactions.

[`record-filter.ts`](../packages/federation/src/record-filter.ts) filters new
records. Public stream removals additionally depend on **previous membership**:
a changed record outside a bbox must remove an older matching copy. Expiry and
validity-end can remove a record without any new database write. Effects with
own geometry influence public bbox membership too. A filtered upsert log does
not implement these transitions.

Existing replay also rechecks source restriction, erases some prior journal
content on revocation, and prunes retained rows. A valid-looking old cursor is
not evidence of retained continuity. A new public cache/journal must propagate
erasure and current public visibility, not resurrect historical payloads.

## Conditions for revisiting durable replay

Proceed only when all of these are established:

- A named public SSE consumer with implemented filter/state ownership and explicit
  reconnect/restart/offline requirements; clarify whether it needs current-state
  convergence or every captured local transition (not unobserved upstream history).
- Measured reconnect rates, response bytes, outage lengths, database work and an
  agreed recovery budget. Show that filtered snapshots/shared polling cannot
  satisfy that workload more simply. The samples above are a baseline, not proof
  of a production need.
- An independently reviewed complete public capture contract, including evidence,
  same-revision serving changes, time-driven exits, filter exits and policy
  withdrawals. Do not silently narrow the old stream to federation's capture.
- A tested snapshot/frontier barrier, query/scope/policy-bound tokens, explicit
  epoch and retained lower frontier, count/byte/age limits, reset fallback for
  unknown/expired/gapped cursors, and current-rights checks/erasure on delivery.
- Disposable-database concurrency tests, reconnect/drop/restart client tests,
  bounded-resource load tests and a staged opt-in migration. No deployment is
  authorized or justified by this investigation alone.

Until then, the engineering cost and silent-loss/privacy failure modes outweigh
an unproven transfer saving. The next useful step is consumer-backed snapshot
semantics, not an anonymous durable subscription subsystem.
