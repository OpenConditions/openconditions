# Inspect a captured situation feed

Use the offline inspector when an upstream incident looks different after
parsing or disappears from an export. It puts the captured payload's hash,
parser draft, canonical validation, geometry/direction/effects, and actual
publisher output in one JSON report. It needs Node/pnpm and a source checkout;
it needs neither a database nor feed credentials and makes no network requests.

## Reproduce a sample

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --silent --filter @openconditions/ingest inspect-feed sg-lta-events \
  --at 2026-06-28T10:00:00Z \
  --payload "$PWD/packages/roads/src/__tests__/fixtures/lta/incidents.json" \
  > /tmp/feed-inspection.json

jq '.inputs, .counts, .warnings' /tmp/feed-inspection.json
jq '.records[] | {id: .draft.id, validation, location: .canonicalPreview.location,
  effects: .canonicalPreview.effects, effectStates, projection}' /tmp/feed-inspection.json
jq '.exports.geojson' /tmp/feed-inspection.json > /tmp/feed-inspection.geojson
jq -r '.exports.traff' /tmp/feed-inspection.json > /tmp/feed-inspection.traff.xml
jq -r '.exports.datex' /tmp/feed-inspection.json > /tmp/feed-inspection.datex.xml
```

`--at` is required and must include `Z` or an explicit offset. It supplies both
the parse's fetch time and the export's evaluation time; use the original poll's
fetch time for a reproducible captured-poll investigation. Source timestamps
remain source timestamps. Repeating the same command with unchanged catalogue,
parser and input bytes produces the same report, including synthetic stamps.
Record the checkout's `git rev-parse HEAD` beside a saved report when comparing
parser versions. `schemaVersion` versions the report shape, not the parser. Preview reports now
use version `2` (structured XML diagnostics and more precise summary reasons);
the unchanged index report remains version `1`.

For a real investigation, supply the already decoded payload bytes that the
parser receives. Archive blobs are zstd-compressed decoded responses: find the
poll's `payload_hashes` and matching `raw_payload.storage_key` in an authorized
local database, then decompress the corresponding blob with `zstd -dc` to a
local sample file. The archive path and retention rules are described in the
[ingest README](../services/ingest/README.md#raw-payloads). An evicted blob cannot
be reconstructed from its index row. Do not fetch a newer payload and label it
as the old poll's input.

Repeat `--payload` for main-role pages/partitions from **the same poll**, in their
original order. Do not combine snapshots from different times. Inputs are
reported in that order with SHA-256 and decoded byte length. The command accepts
at most 64 regular files and 32 MiB total decoded bytes. A preview report is limited to
100 selected situations. Use `--list` for an ID/kind/headline index of up to
20,000 parsed situations, then select one with `--id`. Index mode does not seal
records or produce exports; its IDs and headlines are parser output, not
validation results. Larger previews fail with an example exact ID. Selection happens after parsing; it cannot reduce the parser's workload.

```bash
pnpm --silent --filter @openconditions/ingest inspect-feed sg-lta-events \
  --at 2026-06-28T10:00:00Z --payload /tmp/sample.json \
  --id 'oc:situation:sg-lta-events:1id3hlp' > /tmp/one-record.json
```

To discover IDs without creating canonical/export previews:

```bash
pnpm --silent --filter @openconditions/ingest inspect-feed sg-lta-events \
  --at 2026-06-28T10:00:00Z --payload /tmp/sample.json --list \
  | jq '.records[] | {id, kind, headline}'
```

`--list` and `--id` are mutually exclusive. Index output remains local diagnostic
material and may contain source text subject to redistribution restrictions.

The example ID belongs to the repository fixture; choose an ID from your own
source record/report. An unknown ID fails rather than returning an empty export.
Use `--feeds-dir /absolute/local/feeds` to layer an operator catalogue over the
baked catalogue. The command deliberately ignores environment catalogue and
remote settings. Scheduled, disabled and discovered local feeds can all be
inspected without enabling them or supplying acquisition credentials.

## Read the report

- `counts.parsed` counts drafted situations before exact-ID selection;
  `selected`, `valid` and `publicEligible` describe successive preview stages.
  `accounting` preserves source-record accounting when the parser provides it;
  its counts can differ because several source records form one situation.
  `rejectedByParser` is the parser's reported count, not a count of every lost
  upstream record. `snapshot` preserves the declared completeness inspection;
  a violated snapshot contract fails the command. `truncatedBySource` exposes a
  parser's truncation signal.
- Each `draft` is what the real main-payload parser produced. `validation`
  contains the registry's issue paths/codes/messages when sealing fails. Invalid
  drafts remain visible locally and never reach a publisher.
- `canonicalPreview` uses the same attribution stamping and sealing functions
  as ingestion. `inspect.local`, revision `1`, and `recordedAt=at` are synthetic;
  this record has **not** been stored. Inspect source `provenance.recordId`,
  geometry origin, extent, direction and each effect's own location rather than
  inferring travel order from coordinate order.
- `effectStates` evaluates each effect at the fixed instant. An ended or unknown
  effect can disappear from XML while the situation's nature is still exported.
- `projection.public` applies source restriction and the real public licence /
  upstream-licence filtering. The actual GeoJSON/XML use the resulting public
  records, including reporter stripping. A source/rights refusal is separate
  from `projection.traff` or `.datex` refusing a mapping. XML counts come from the
  actual publisher; a situation can produce multiple messages/records.
  `reason` is a summary: source/rights refusal first, otherwise the first
  exporter withholding code if nothing was emitted, or `no_representable_message`
  when no representable event remains. It is `null` if anything was emitted,
  even when some fields or effects were lost. Read `diagnostics` in both cases.
- `exports` holds the real emitter output for the **selected** public-eligible
  previews. Compare it with canonical geometry, applicability and effect states.
  DATEX reduces locations to representative points and is not an SRTI/NAP
  publication; see [DATEX conformance](datex-conformance.md). TraFF may also omit
  unsupported events or location detail. A successful emission is not a claim
  of lossless conversion or acceptance by a navigation client.

### Explain XML losses

Each `projection.traff.diagnostics` and `projection.datex.diagnostics` entry
comes from the actual exporter decision path, evaluated against the
public-eligible preview. It includes:

- `code`: a stable machine-readable decision code; use this rather than matching
  the explanatory `message` text.
- `scope`: `situation` for an entire-situation gate, `message` for an individual
  TraFF message, `effect` for a skipped effect, or `field` for an omitted/reduced
  field. Withholding the parent TraFF message can still leave an own-location
  effect message in the output.
- `disposition`: `withheld`, `omitted` or `reduced`.
- `path`: an RFC 6901 JSON pointer into `canonicalPreview`, including indexed
  phase paths such as `/details/phases/0/effects/0/location/fuzziness`.
  An inherited direction points to `/location/direction`, rather than a field
  absent from the effect. A gate can point to a required field missing from a
  legacy draft caller; the inspector itself projects sealed records.
- `situationId`, plus `effectId` when the decision concerns an effect.

| Code                                       | What it explains                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coarse_location`                          | A root or effect location has non-exact precision, including coarse VILD recovery. Both XML exporters withhold the whole situation; GeoJSON can retain it.     |
| `vehicle_specific_effect`                  | Vehicle applicability or an intrinsically vehicle-specific effect kind cannot be represented faithfully; the whole situation is withheld.                      |
| `restriction_evidence`                     | Incomplete normalization or unknown applicability blocks the whole situation. Multiple applicable blockers are reported.                                       |
| `unrepresentable_direction`                | TraFF cannot infer travel order from an explicit direction. An effect direction blocks the situation; a root/inherited location direction blocks that message. |
| `direction_not_exported`                   | This DATEX emitter omits direction while still emitting records. This describes the current emitter, not a limitation of the DATEX standard.                   |
| `geometry_to_point`                        | An emitted non-point geometry becomes its first coordinate.                                                                                                    |
| `geometry_to_endpoints`                    | TraFF emits only the endpoints of a line with intermediate coordinates.                                                                                        |
| `missing_geometry`                         | A TraFF message has no usable coordinate and is withheld.                                                                                                      |
| `effect_ended`, `effect_time_unknown`      | The XML effect projection was skipped at the fixed evaluation instant. Scheduled effects remain eligible.                                                      |
| `unsupported_nature`, `unsupported_effect` | The current registry/emitter has no event/management-record mapping for this classification or effect. Other messages/records can survive.                     |
| `field_not_exported`                       | A specifically instrumented field is omitted, currently TraFF delay duration (queue length can still travel).                                                  |

```bash
jq '.records[] | {id: .draft.id,
  traff: .projection.traff, datex: .projection.datex}' /tmp/feed-inspection.json
jq '.records[].projection | .traff.diagnostics[], .datex.diagnostics[]
  | select(.disposition == "reduced")' /tmp/feed-inspection.json
```

Invalid drafts and records withheld by source/rights policy have empty XML
diagnostic arrays; their earlier refusal is in `reason`. Export diagnostics do
not override validation or public filtering. Geometry reductions are reported
only for emitted locations, not every geometry stored on the situation.

This is a **non-exhaustive explanation of instrumented exporter decisions**.
An empty array does not certify a lossless conversion: other canonical metadata,
quantifiers, text, validity detail or duplicated events may not travel. Inspect
`exports` for the authoritative result. DATEX delay duration is a leading-record
supplement, selected independently of management-effect time filtering; its
presence is not evidence that the delay effect is active. Diagnostics deliberately
do not label that entire effect withheld merely because its window ended.

An empty parse is **not** proof of an empty source. Some legacy parsers return
nothing for malformed/unsupported input and do not report every rejection. The
inspector flags an empty parse with `empty_parse_is_not_proof_of_empty_source`;
check the raw bytes, expected format and completeness contract before concluding
that events were withdrawn.

The report is local diagnostic material. Its drafts and canonical previews can
contain restricted source content even when `exports` is empty. Review contents,
licensing and privacy before sharing it; public export filtering does not make
the whole report public.

## Small reproducible corpus

The tests use these existing captured fixtures through the real parser, sealing
seam and publishers; no production secrets or additional captures are needed.
Use the same command, replacing source and payload:

| Source                  | Payload under `packages/roads/src/__tests__/fixtures/` | Inspect                                                                                                     |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `sg-lta-events`         | `lta/incidents.json`                                   | Point incidents, stable source identity and GeoJSON/XML output                                              |
| `lu-cita-events`        | `cita-lu/situations.xml`                               | DATEX grouped source-record accounting, effects and canonical validation                                    |
| `fi-digitraffic-events` | `digitraffic/weight-restriction.json`                  | Curved source geometry and vehicle applicability retained in canonical/GeoJSON; XML withheld conservatively |

The unit suite additionally probes invalid coordinates, restricted/non-public
sources, exact-ID selection, malformed/empty input and report limits. Run it with:

```bash
pnpm exec vitest run --project unit \
  services/ingest/src/__tests__/feed-inspect.test.ts \
  services/ingest/src/__tests__/feed-inspect-command.test.ts
```

For a reader check, extract the XML above and load it in the intended external
consumer. Preserve its version and observed result alongside the report; a
publisher unit test alone does not verify a consumer. If that checkout includes
the optional `scripts/traff-interop/check.sh` harness, it provides the pinned Java
reader baseline described in `docs/traff.md`.

## Continue into actual ingestion and consumer state

This inspector is main-role **situation feeds only**. It does not supply reference
roles, resolve OpenLR, bind roads, fuse records, simulate snapshot withdrawals,
apply API validity/expiry/bbox/dedupe filters or reconstruct database history.
Missing reference data is not proof that a source cannot be placed. It is also
not a bounded-memory sandbox for arbitrary parsers: the input/output limits do
not bound parser CPU or intermediate allocations.

When a preview differs from actual serving, continue with the existing tools:

1. Check source status and the poll attempt to establish acquisition success,
   payload identity and the publication boundary.
2. Run [raw replay](storage.md#replay) against authorized archived situation polls
   to compare the current parser with the revisions actually stored. It reports
   evicted inputs and changed/new/gone/unplaced IDs; it does not reproduce every
   domain or an arbitrary historical database state.
3. Read the situation and its revisions through the authenticated operator API
   as needed; compare source ID, content hash, freshness and tombstones. A public
   response can legitimately withhold a record available to an operator.
4. For routing, inspect [graph binding](graph-binding.md) and run the existing
   `road-conditions:readiness` check. Only live binding evidence can establish
   which graph spans are eligible. This tool invents no binding confidence.
5. Test the actual client's lifecycle separately: a bbox departure, locationless
   cancellation, replacement ID or rights withdrawal must remove/replace the
   old display/routing state. A one-snapshot offline export cannot demonstrate
   reconnect, delta or withdrawal correctness.

These boundaries keep a parser/export reproduction useful without presenting a
local preview as evidence of production ingestion or navigation acceptance.
