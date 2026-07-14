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

## Scope

The spike stops at "the submission/aggregation crypto is proven." It does **not**
run an on-device pipeline, a Collector DP release, or any network call to a real
aggregator, and it does **not** mark Phase P-1 passed — the physical and P0 gates
remain.
