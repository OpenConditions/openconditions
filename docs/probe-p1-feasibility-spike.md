# Probe layer — Phase P-1 feasibility spike (decision gate)

> **Status: P-1 is NOT passed. The probe layer is NOT committed.** This document is the P-1 _spike deliverable_:
> the interoperability/tooling finding, the physical-device measurement protocol with explicit acceptance
> thresholds, and the DAP + differential-privacy design agenda for the independent reviewer. It exists so the
> decision to build (or defer) the probe layer can be made **on evidence, before any Phase P0–P6 code is written**.
>
> Binding sources (this doc must not contradict them): OpenConditions' commons and probe-layer design
> decisions; the shared Privacy-Pass token layer already built in `services/contributions-api`
> (Attester/Issuer); the speed-congestion fusion seam (`segment_observation`).

## 1. Why this gate exists

The entire probe privacy model rests on one load-bearing assumption: **raw trajectories never leave the device —
only `(segment, window, clamped speed)` tuples do.** That is only true if continuous on-device map-matching is
feasible on a real, mid-range phone at acceptable battery, storage and accuracy. If it is not, the model collapses
to "send GPS to a server," which is exactly what this layer exists to prevent. So feasibility is decided **before**
committing to build, not discovered mid-build.

P-1 has six sub-gates. All six must pass to commit to P0–P6. They split into work that is verifiable here (in CI,
without a device or an external party) and work that is **structurally blocked** on a physical device, an
independent reviewer, or a maintained implementation that does not currently exist.

| #   | Sub-gate                                                                        | Nature                              | State                                                                            |
| --- | ------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Battery / thermal on a mid-range phone over a multi-hour drive                  | physical device                     | **BLOCKED — needs the operator + a phone**                                       |
| 2   | On-device routing-tile storage footprint + refresh story                        | physical / real tile build          | **BLOCKED — needs a real matcher build**                                         |
| 3   | Match accuracy to the server spine keyspace (`way_id:dir`, carriageway `f`/`b`) | physical (labelled test drive)      | **BLOCKED — needs a test drive vs a server reference**                           |
| 4   | Privacy invariant: no coordinate/plaintext tuple crosses the network boundary   | CI-assertable + real-device capture | **BLOCKED — CI invariant specifiable now; real-device proof needs a test build** |
| 5   | Anonymous contribution-bound + DAP/VDAF protocol + threat model                 | crypto correctness (buildable)      | **BLOCKED on tooling — see §3**                                                  |
| 6   | DAP + DP design review (privacy unit, adjacency, ε/δ accountant, mechanism)     | design + independent review         | **BLOCKED — acceptance is reviewer-gated (P0)**                                  |

**Nothing in this spike marks any sub-gate "passed."** Simulator or desktop numbers do not satisfy 1–4; only real
mid-range-phone evidence does. Item 6 acceptance requires the P0 independent privacy reviewer, by the probe-layer
design's own rule ("P0's independent reviewer must approve it").

## 2. Reconnaissance summary (what exists today)

- **No probe / DAP / VDAF / Prio3 / DP code exists** in the repo — only reserved DB columns (`dp_epsilon`,
  `dp_delta`, `k_anonymity`, `privacy_class` on the canonical **`observations`** model; `segment_observation`
  carries **none** of them — that gap is the P5 additive migration) and deliberate seam comments
  (`packages/publishers/src/archive.ts`, `services/contributions-api/src/issuer/context.ts`,
  `services/contributions-api/src/attester/policy.ts`). This is the intended greenfield starting point.
- **The Privacy-Pass token layer a probe would reuse already exists and works**, server-side, in
  `services/contributions-api/src/issuer/` + `.../attester/` on `@cloudflare/privacypass-ts@0.9.0` (RFC 9578
  Blind-RSA). Reusable surface, verbatim from the contributions-api crowd-report layer:
  - `PublicContext { purpose; taskId?; epoch }`, `publicContextString` → `` `${purpose}:${taskId ?? "-"}:${epoch}` ``,
    `redemptionContext(ctx)` → **server-authoritative** `SHA-256(purpose:taskId:epoch)` — the probe context is
    literally `purpose: "probe"` (the context hashing is already proven purpose-agnostic in tests).
  - `issueToken(...)` with atomic per-key-per-epoch quota (`INSERT … ON CONFLICT … WHERE issued < cap`);
    `TokenVerifier.verify(...)` with insert-first single-use redemption into `conditions.spent_token` and a
    `timingSafeEqual` challenge-digest check.
  - **No production client-side token-request module exists** — `publicVerif.Client.createTokenRequest` is only
    exercised in tests. A probe reporter (OpenMapX side) would add the client, reusing the same pinned library.
- **The landing target exists**: `segment_observation` (`packages/core/src/db/schema.ts`) with
  `(segmentId, source)` PK and `sourceTier`, and the tier-priority reducer `fuseSegmentSpeed`
  (`services/ingest/src/pipeline/segment-speed.ts`) — `SELECT DISTINCT ON (segment_id) … ORDER BY tier, observed_at DESC`,
  where `crowd` is the lowest tier. The privacy-accounting columns the probe-landing step (P5) needs are **not yet
  present** (that is the P5 additive migration — not built here, it is gated behind P-1 passing).

## 3. The decisive tooling finding (item 5 interoperability spike result)

The spike's first job is to select "the exact draft-18 VDAF profile and a maintained implementation" and forbids
hand-rolling DAP. The interop finding is decisive and blocks a _conformant_ build today:

- **DAP/VDAF for Node/TS.** Two draft identities matter and must not be conflated: **DAP** (the aggregation
  _protocol_) reached IETF WG consensus at **draft-18**, while the **VDAF** it carries is a _separate_ document
  (currently around draft-19); the exact VDAF profile/draft to pin is itself a reviewer decision (§5.2.1). The only
  maintained Node-usable DAP client is `@divviup/dap` (0.9.1) with `@divviup/vdaf` / `@divviup/prio3` (0.8.0). It
  exposes a real `Task` / `sendMeasurement` client — but it implements **DAP draft-09 / VDAF draft-08**, last
  published **2024-11-14**, i.e. well behind the draft-18 DAP consensus and the current VDAF draft. There is **no
  maintained JavaScript/TypeScript implementation at the draft-18-DAP / current-VDAF level.** The current-draft
  reference implementation is `libprio-rs` (Rust); it has **no published Node/WASM binding**. Janus (Rust) is
  Leader/Helper server infrastructure, not a client library.
- **Consequence.** A DAP client at the pinned drafts with pinned interop vectors — which item 5 requires — **cannot
  be built from maintained JS tooling today** without either (a) accepting the stale draft-09 divviup stack (not the
  committed profile, and years behind), or (b) wrapping `libprio-rs` via a Rust/WASM component the operator must be
  willing to build and run. Both are decisions for the operator + the independent reviewer, not something to settle
  by autonomously committing non-conformant code. This is a legitimate spike _finding_, and it is a gate that
  cannot go green here.
- **Differential-privacy primitive.** No maintained **in-process** JS DP bounded-sum/mean primitive exists. The
  non-hand-rolled options are all **out-of-process**, which the probe-layer design anticipates ("Google `differential-privacy` …
  run as a Go binary beside the BFF"): Google's `differential-privacy` Go module (`dpagg.BoundedSumFloat64`,
  v4.1.0, 2025-02) invoked as a subprocess wrapper, or OpenDP/PyDP via a Python service. Adopting either introduces
  a **new toolchain (Go or Python) into this TypeScript monorepo** — an operator/architecture decision, not a
  unilateral one. The sole npm-native DP package (`differential-privacy` by a single maintainer, last published
  2022-10) is **not** suitable for a privacy-sensitive primitive and is rejected.

**Net:** item 5 cannot reach a conformant _pass_ with today's maintained JS libraries. The spike's recommendation
(§5) is an explicit decision the reviewer + operator must take before any DAP code is written.

## 4. Physical-device measurement protocol + acceptance thresholds (items 1–4)

This is the artifact needed to **obtain** the P-1 evidence. It must be run by the operator on a real mid-range phone
(not a flagship, not a simulator). The proposed thresholds below are **starting values to be confirmed by the
operator + the independent reviewer** — the probe-layer design requires the threshold to be "set explicitly," and
the review signs off on the numbers.

### 4.1 Battery / thermal (item 1)

- **Setup.** A mid-range phone (e.g. a ~2-year-old mid-tier Android, explicitly _not_ a current flagship). A
  minimal instrumented build running continuous on-device map-matching (Valhalla Meili `trace_attributes`, or a
  lighter on-device matcher) over a realistic multi-hour driving day. Screen state and radio held constant across
  the control and treatment runs.
- **Method.** Two matched drives of the same route/duration: control (matcher off) vs treatment (matcher on).
  Record battery percentage per 15-minute interval and device skin/CPU temperature. Compute _incremental_ drain =
  treatment − control.
- **Proposed acceptance.** Incremental drain **≤ 5%/hour** on the mid-range device, and **no sustained thermal
  throttling** over the multi-hour run. (Partial pass: if only newer phones clear it → the Contributor tier ships
  **device-gated** to capable hardware, documented honestly; never by degrading the privacy guarantee.)

### 4.2 Tile storage (item 2)

- **Method.** Build the on-device routing tiles the matcher needs for **one contributor metro region**; measure the
  on-disk footprint and define the download + refresh path (tie to the app's existing tile pipeline where possible).
- **Proposed acceptance.** Footprint **≤ 400 MB** per contributor metro region; refresh reuses the app's existing
  tile story (no bespoke second pipeline). Confirm the number against the actual target region.

### 4.3 Match accuracy to the spine keyspace (item 3)

- **Method.** A labelled test drive. Run the on-device matcher and a **server-side Meili reference** over the same
  GPS trace. Key both to `segment_id = "${way_id}:${dir}"` (Meili `way_id` + `traverse_direction` → `f`/`b`).
  Compute per-fix agreement of `way_id` and of carriageway direction against the reference.
- **Proposed acceptance.** `way_id` agreement **≥ 90%** and carriageway (`f`/`b`) correct **≥ 95%** on the labelled
  drive — good enough that bucketed speeds are trustworthy. Confirm against a labelled ground-truth set.

### 4.4 Privacy invariant in practice (item 4)

- **The invariant (stated correctly for the DAP wire format).** The probe export path reduces GPS to at most one
  sampled `(segment_id, ~5-min UTC window, speed clamped [0,200])` tuple per epoch, and then **encodes that tuple as
  a single DAP report (encrypted VDAF input shares)** before it leaves the device. So on the network there is
  **never a coordinate, never a point stream, never an origin/destination or dwell, and never a plaintext tuple
  field** — the only artifact that crosses is one DAP report whose _visible_ task/public metadata exactly matches
  the P-1 disclosure. (A CI gate asserting plaintext tuple fields on the wire would be _wrong_ — it would mandate
  exactly the plaintext upload the committed design forbids.)
- **CI part (specifiable now, before any client exists).** When the P1 client is built (gated), a CI test must
  assert that (a) the on-device candidate buffer is reduced to at most one sampled tuple per epoch and the plaintext
  candidates are deleted, and (b) the serialized upload is a well-formed DAP report exposing only the disclosed
  task/public metadata — a raw coordinate or extra field injected into the pre-encoding buffer must be _dropped or
  fail VDAF validity_, never shipped. This is a **required P1 acceptance gate**, specified here so it is not
  forgotten; it is not built now because there is no client to instrument and building one is Phase P1 (gated).
- **Real-device part.** On the instrumented test build, run the probe path behind mitmproxy/Charles over a real
  drive. **Acceptance (binary):** no coordinate and no plaintext tuple field ever crosses the network boundary on
  the probe path; the only observed upload is a single DAP report (encrypted shares) per epoch, sent after the
  randomized jitter over the anonymous-token-authenticated `/probe` route, and a network capture cannot reconstruct
  a tuple sequence or any VDAF-private field.

## 5. DAP + DP design agenda for the independent reviewer (items 5–6)

This is the **agenda a P0 independent reviewer signs off**, not a settled design. It states the design-committed
constraints (fixed) and the open decisions (reviewer + operator). Writing settled ε/δ values, a chosen VDAF profile,
or a chosen DP mechanism into code here would pre-empt the review the design reserves — and would risk manufacturing
exactly the plausible-but-wrong privacy artifact the whole gated design exists to prevent.

### 5.1 Committed constraints (fixed by the commons design — not open)

- **On-device only.** Map-match to `way_id:dir`; trim first/last ~200 m of every trip _before_ bucketing; reduce
  candidates to `(segment_id, ~5-min UTC window, speed clamped [0,200])` with at most one candidate per
  `(segment, window)`, then **sample at most one tuple per epoch-bound entitlement** — a multi-segment trip exports
  **at most one measurement per epoch**, not one per segment crossed (this per-epoch bound is what makes the DP
  sensitivity accounting sound). Raw trajectories never leave the device.
- **Submission.** Reuse the contributions-api's single-use RFC 9578 Privacy-Pass token (self-hosted Attester + Issuer) as the
  anonymous admission credential; the Origin sees only "a valid token," never identity or which token. **No probe
  pseudonym** enters either input share. No-log ingest edge (drop IP before persistence; if abuse control is
  demonstrably needed, a **short-epoch keyed HMAC behind a rotating key**, documented as personal data, deleted on
  schedule — **never** reversible/prefix-preserving IPCrypt as "anonymity"). Randomized minutes-scale upload jitter.
- **Metadata boundary.** DAP alone does **not** hide the uploader's IP from the Leader. The committed v1 metadata
  hardening is **OHTTP (RFC 9458) through an independently operated relay** (self-hosted
  `cloudflare/privacy-gateway-server-go`, run by a _different_ operator — a sibling federation peer or a nonprofit —
  so the non-collusion requirement is actually satisfiable). Optional opt-in Tor is a user-side toggle only, off by
  default; it is not the committed metadata mechanism.
- **Aggregation.** DAP/Prio3: device shards a bounded measurement between a Leader and an **independently governed**
  Helper (a same-operator second server adds no privacy protection and must be impossible to enable for production
  publication). The Collector applies **private partition selection + a DP mean / noisy sufficient statistics** with
  explicit ε/δ. **Exact raw contributor count is never published and never used as an unproved public divisor.**
- **Privacy unit = one admitted device-key epoch** — _never_ claimed as "person" or "human"; the multi-device /
  multi-account caveat is disclosed. **Adjacency = add/remove-one-device-epoch** unless an alternative is explicitly
  proven and reviewed.
- **Tumbling, not sliding.** Fixed, non-overlapping public epochs and a versioned release manifest fixed **before**
  private data is inspected. No sliding windows, no data-dependent partition lists, no adaptive bounds, no
  accuracy-peeking, no "rerun until useful."
- **Idempotent randomness/retry.** A retry returns the already-committed release + accounting receipt (or resumes
  the same transaction/seed under the library contract). It **never** samples fresh noise or spends budget twice.
- **User-level composition.** ε/δ tracked across every segment/resolution/window a contributor can affect under the
  protocol bound — not merely per segment. Fail closed when the rolling budget is exhausted.
- **Sparse cells.** Widen temporally first (fixed accounted tumbling resolutions), then a road-class/corridor
  aggregate **only on a separate corridor surface — never smeared back onto per-segment speed**; flag lower
  confidence; suppress below threshold (auditably, never silently).
- **Landing.** One `segment_observation` crowd row per cleared cell: `source='crowd'`, `source_tier='crowd'`
  (lowest — surfaces only where no better source exists), `current_kph`=DP mean, `sample_count=NULL`,
  `privacyClass='dp_noised'`, composed `dpEpsilon`/`dpDelta`, `privacyUnit='admitted_device_key_epoch'`,
  `adjacencyRelation='add_remove_one'`, pinned mechanism/accountant version. Additive nullable migration; the fusion
  reducer's **tier logic is unchanged** (a pass-through of the privacy columns only).

### 5.2 Open decisions the reviewer + operator must resolve

1. **DAP + VDAF draft pin, profile + implementation path (from §3).** First **pin the exact DAP and VDAF draft
   numbers** the deployment targets (they version independently — §3). Then choose the implementation path: accept
   the stale draft-09 divviup stack for a spike-only prototype; wrap `libprio-rs` (current draft) as a Rust/WASM
   component; or defer until a maintained client at the pinned drafts exists. The committed profile must
   cryptographically enforce **exactly one eligible segment** and a
   **bounded fixed-point speed** per admitted report (per-coordinate bounds alone are insufficient — a malicious
   client could set many coordinates). Compare at least (A) a private one-hot segment inside a coarse public
   region/window via a bounded-vector/custom validity circuit, and (B) a coarser public partition with only
   count/speed private — on report bytes, mobile CPU/battery, aggregator cost and leakage.
2. **DP mechanism + accounting.** Which library (Google DP Go binary vs OpenDP), run out-of-process (§3). Evaluate
   **Gaussian + RDP/zCDP accounting against the library's standard approximate-DP mechanism** for the
   many-statistic / repeated-release workload, then publish a **conservative composed (ε, δ)** — not a mechanism
   picked by slogan or single-query accuracy. Concrete ε precedent to weigh: Google's COVID-19 Mobility Reports held
   **ε = 0.44 per window** specifically to bound temporal composition.
3. **Contribution bounds.** Maximum contributions across cells and rolling periods; the public partition/resolution
   schedule; the minimum DAP batch; task expiration and deletion of aggregate shares; exactly what the Collector may
   query and retain.
4. **Grey-box audit.** How the DP glue is instrumented so neighboring add/remove-one-device-epoch executions verify
   declared sensitivity and **identical data-independent control flow, bounds, parameters and query count**.
   Evaluate the PETS 2026 `dp-recorder` record/replay tool in an isolated pinned harness (no release; not a
   production dependency); if it cannot instrument the chosen language/library, implement equivalent record/replay
   assertions around the trusted DP primitive boundary. CI must catch unclamped/NaN inputs, data-dependent
   noise-scale/threshold/loops, multi-partition influence and fresh-noise-on-retry bugs.

### 5.3 Rejected alternatives (do not revisit without new evidence)

- **STAR** — above threshold it hands the operator raw per-contributor values; for "publish the segment mean" that
  is no stronger than a trusted server + suppression while _adding_ a randomness-server dependency. Rejected.
- **Local DP (RAPPOR-style)** — needs 10⁵–10⁶ reports and the noise does not shrink as contributors join;
  non-viable at our thousands-scale. Rejected.
- **A plaintext / single-aggregator / raw-tuple / server-GPS bootstrap** — breaks the model's whole premise.
  **Never build it.** If DAP+DP is not viable, the probe layer is **deferred**, and the sensor + official-feed base
  (speed-congestion) remains the coverage mechanism; the crowd-report layer is unaffected.

## 6. The STOP boundary — what only the operator / an outside party can do

P-1 cannot be completed in this environment. It is blocked on three independent gates:

1. **Physical-device evidence (items 1–4).** Run §4 on a real mid-range phone; record the numbers against the
   confirmed thresholds. Requires the operator + hardware + a labelled test drive. _(A partial pass — feasible only
   on newer phones — ships the Contributor tier device-gated, documented honestly; a protocol/DP failure has no
   partial-pass exception.)_
2. **The DAP/VDAF tooling decision (item 5, §3 + §5.2.1).** No maintained JS client exists at the draft-18-DAP /
   current-VDAF level; hand-rolling DAP is forbidden. The operator + reviewer must choose the profile + implementation path (and accept any new
   Rust/Go/Python toolchain) before conformant DAP code is written.
3. **The P0 institutional gate (item 6 acceptance + launch).** Before any probe code ships:
   a **public DPIA** + a **scoped public threat-model doc**; a **commissioned independent privacy review** (academic
   / civil-society) of the DPIA + threat model + the k/ε parameters, **passed and published**; a **DSB appointed**
   and **Cyber-Versicherung bound**; the **crowd-report layer proven durable in production** (probe
   ships _after_ crowd reports prove durability); a **contracted independent DAP Helper operator** with a reviewed
   MoU/DPA (task config, key rotation, retention/deletion, incident response, termination, emergency migration) and
   an **out-of-band key exchange** — a cloud account or second service controlled by us does **not** pass this gate;
   and an **independently operated OHTTP relay** (§5.1 metadata boundary) run by a _different_ operator than the
   aggregator.

Only when all three clear does P-1 pass. Building P0→P6 then _additionally_ requires the probe-layer prerequisite
gate — the substrate commons fields on `segment_observation` (the P5 additive migration), the contributions-api
Attester/Issuer, and the live speed-congestion `segment_observation` seam — so a P-1 pass is necessary, not
sufficient, for build.

## 7. Honesty channel (non-negotiable)

Even a fully-built stack is honest about its limits, and so is this spike:

- **k ≥ 10 is a deliberate design choice, not a formal guarantee** (MDS's published threshold is the only public
  precedent; Apple/Strava have never published theirs — do not cite the "Strava = 5" rumor). The floor is defense in
  depth; the DP noise is the actual protection; neither alone suffices.
- **Threshold-crossing is itself a signal**; **chained-window inference remains possible**; **entitled keys ≠
  humans** (Sybils can raise the raw floor); **Sybil threshold-gaming can make the gate an oracle**. These are
  mitigated by the _stack_ (DP noise + suppression + jitter + edge-trim + the Attester Sybil-cost gate + user-level
  composition), not removed by any single layer. Evidence base to cite: the **Strava heatmap**, **"Trajectory
  Recovery from Ash" (WWW'17)** (73–98% trajectory recovery from pure per-cell counts, _rising_ as data gets
  sparser — the exact sparse regime here), and **"Ghost Riders" (ToN'18)**.
- **We never build a "nearby users" / live-presence feature** — a documented tracking vector.
- **The trust boundaries, stated plainly:** individual inputs are confidential **only if the Leader and Helper do
  not collude**; the **Collector/accountant and its reviewed DP implementation remain trusted** for safe output
  release; and **DAP does not hide the uploader's IP from the Leader** — the independently operated OHTTP relay
  (§5.1) is what handles that metadata boundary, not DAP. **Low-density residual re-identification risk is mitigated,
  not eliminated.**
- The `privacyClass` / `kAnonymity` / `dpEpsilon` fields travel on **every** published row so the posture is
  machine-legible to consumers and federation peers — no honesty in the README that isn't also in the data.

## 8. What was intentionally not built here, and why

- **No P0–P6 production code** (client pipeline, Leader/Helper/Collector, landing migration). The spike must
  pass before any other probe-layer work is committed.
- **No DAP/VDAF client on the stale draft-09 lib, and no new Go/Python DP toolchain** committed to `main`. Both are
  operator + reviewer decisions (§3, §5.2); committing a chosen profile/mechanism would pre-empt the P0 review and
  risk a non-conformant or unsupportable privacy artifact.
- **No claim that any sub-gate passed.** Simulator/desktop numbers do not count; item 6 acceptance is reviewer-gated.

The probe layer stays deferred until P-1's three gates clear. The sensor + official-feed base and the
crowd-report layer are the coverage mechanisms in the meantime, and neither is affected by this deferral.
