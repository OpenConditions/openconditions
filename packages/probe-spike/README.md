# @openconditions/probe-spike

> **NON-PRODUCTION FEASIBILITY SPIKE.** This package exists to prove, in CI and
> with no physical device, the cryptographic invariants the privacy-probe
> submission path requires. It is deliberately isolated: **no production
> service may depend on it.**

## Why it is isolated

The spike proves the submission/aggregation crypto against a **maintained** VDAF
implementation — [`@divviup/prio3`](https://www.npmjs.com/package/@divviup/prio3)
and [`@divviup/vdaf`](https://www.npmjs.com/package/@divviup/vdaf). Those libraries
implement **DAP draft-09 / VDAF draft-08**. The production profile targets a
later DAP/VDAF draft (or a `libprio-rs` wrapper), so the draft-09/08 dependency
must never leak into a production dependency tree. Quarantining it in one
private, non-production package is the whole point.

A guard test greps the workspace to assert nothing under `services/*` imports
`@openconditions/probe-spike`.

## What it proves

1. **One-hot segment enforcement** — a valid single `(segment, speed)` cell
   encodes; a multi-hot or out-of-range measurement fails VDAF validity at the
   aggregators (the FLP proof, not a client-side check).
2. **One admitted key/epoch → at most one accepted contribution** — reuses the
   shipped Privacy Pass admission layer (`@openconditions/contributions-api/contrib`):
   per-epoch quota, single-use redemption, domain-separated context binding.
   This invariant holds ONLY when probe issuance is capped at one token per
   epoch: the spike exports `PROBE_TOKENS_PER_EPOCH = 1` and the production probe
   issuance path MUST pass it to `issueToken`. The shipped attester default
   (`grantTokensPerEpoch = 20`) does NOT enforce this on its own.
3. **Replay cannot enter two batches** — a replayed token or a replayed report
   id/nonce is rejected before aggregation.
4. **Share confidentiality** — neither the Leader nor the Helper share (input or
   output) alone reveals the segment or the speed; only the combined aggregation
   over the batch yields the aggregate.
5. **Encoding benchmark (A) vs (B)** — private one-hot segment (Prio3Histogram)
   versus a coarse public partition with only speed private (Prio3Sum): report
   byte size and client encode CPU time.
6. **Same-operator Helper is test-only** — a guard throws if a production config
   tries to publish with a Leader and Helper run by the same operator.

## DP release-glue (`src/dp/*`)

A second, independent half of the spike proves the **software correctness of the
differential-privacy RELEASE GLUE** — the layer where real DP-integration bugs
live — **without hand-rolling any DP primitive and without making any
differential-privacy guarantee.**

The actual noise sampling and the (ε,δ)/RDP/zCDP accounting curve stay **behind
the `DpMechanism` interface**. Production wires a maintained out-of-process
library (Google `differential-privacy`, or OpenDP); the spike supplies a
**recording test double** that records the call sequence + parameters and returns
a deterministic stand-in value. No number the glue produces is claimed to be
private — that claim belongs to the real library and the P0 reviewer.

What the glue proves (tests in `src/__tests__/dp*.test.ts`):

1. **Clamp + contribution-bound** — one tuple per privacy unit per `(segment,
window)` cell, every speed clamped into `[0,200]` before the mechanism is
   called (999 → 200, −5 → 0, NaN → 0).
2. **Private selection, no exact-k** — a cell is released only if
   `selectPartition` returns `released`; the raw contributor count is never
   published or used as a divisor; below-threshold cells are suppressed auditably.
3. **Tumbling windows, fixed manifest** — non-overlapping epochs fixed in a
   versioned manifest chosen independent of the data; overlapping/sliding windows
   are rejected by construction; two datasets yield the identical manifest,
   partition list, and query count.
4. **Idempotent retry** — a retried release returns the committed result and
   re-invokes the mechanism zero times, spending budget exactly once.
5. **User-level budget, fail-closed** — cumulative (ε,δ) tracked per privacy unit
   across every cell it can affect, using **conservative basic sequential
   composition** (Σεᵢ) as the floor (the library's advanced/RDP accounting gives
   tighter bounds — not implemented here); exhaustion suppresses.
6. **Grey-box add/remove-one-device-epoch audit** — two neighboring datasets
   drive byte-identical mechanism call sequences, parameters, and control-flow
   traces. Guard tests deliberately trip on unclamped/NaN input, a data-dependent
   noise scale, multi-partition influence, and fresh-noise-on-retry.

The glue queries **every public partition unconditionally** so the call schedule
is a pure function of the manifest; suppression filters the output rows, not the
query schedule — which is what makes the grey-box audit pass by construction.

## Scope

The spike stops at "the submission/aggregation crypto **and** the DP release glue
are proven." It does **not** run an on-device pipeline, a real Collector DP
release with a real mechanism, or any network call to a real aggregator; it does
**not** write `segment_observation` or add any migration; and it does **not** mark
Phase P-1 passed — the physical and P0 gates remain.
