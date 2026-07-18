# Sybil resistance & the co-location proximity graph — a design assessment

> **Purpose.** OpenConditions' crowd-report trust model gates the two high-consequence levers — **routing
> eligibility** and **reporter reputation** — on external resolution only (an official-feed cross-validation, a
> reviewer, or an objective later state), never on peer corroboration alone. That conservative default exists because _peer corroboration cannot
> currently prove distinct humans_: two colluding keys — or a scripted Sybil fleet — manufacture "corroboration" for
> free. The "real" defense the research literature points to is a **co-location proximity graph** (the Ghost Riders
> defense). This document assesses whether to build it now, what limits it, and what is buildable in the meantime.
>
> **Bottom line up front.** Investigating is worthwhile, but the _literal_ co-location graph is **not** a near-term
> build: it is blocked by a direct conflict with our privacy model, a user-density bootstrap problem, significant
> mobile work, and the fact that a formal Sybil-resistance guarantee on a sparse graph is an open research problem.
> The near-term, privacy-compatible, design-safe work is **device-attestation-as-Sybil-cost** (advisory, non-gating —
> shipped in part) plus keeping the co-reporting graph **monitoring-only**. The co-location graph stays an
> aspirational end-state gated on a privacy-preserving proximity design _and_ user density.

## 1. What the co-location defense is, and why it is "the real one"

"Ghost Riders: Sybil Attacks on Crowdsourced Mobile Mapping Services" (Wang et al., IEEE/ACM ToN 2018) showed that a
single commodity server can run ~1,000 scripted "ghost" devices (≈2% CPU, ≈11% memory) that fabricate traffic,
hazards, and even track users on Waze — because Waze authenticates neither device identity nor GPS origin. Their
survey of standard defenses is the decisive part for us: **email/SMS verification, CAPTCHA, IMEI checks, motion
fingerprinting, and IP reputation all fail** against a scripted attacker with real cellular connectivity — every one
is bulk-purchasable or spoofable.

Their proposed defense is **co-location edges**: an edge records that two _real_ devices were verifiably physically
near each other. Honest users accumulate a dense web of co-location edges with the real population; a Sybil cluster,
having no real bodies, cannot form them, so community-detection isolates it. This is "the real one" because it
attacks the property a Sybil script fundamentally _cannot_ fake — **physical presence among real people** — rather
than a credential it can buy.

## 2. Why it is not a near-term build — the four limiters

### 2.1 The privacy conflict (the decisive one)

Building co-location edges requires **location or device-to-device proximity data**, which collides head-on with the
rest of this system:

- Server-side location collection is prohibited by our posture.
- The entire probe-data layer (`docs/probe-p1-feasibility-spike.md`) exists so that raw GPS/trajectories **never
  leave the device**.
- OpenConditions' design explicitly forbids a **"nearby-users / live-presence" feature** — a documented tracking vector (Ghost
  Riders itself shows a presence layer leaks movement).

So the naive version — attach GPS to each report and cluster server-side — is a non-starter; it _is_ the tracking
feature we refuse to build. A privacy-preserving version needs **device-to-device attestation** (e.g. BLE proximity
exchanging signed nonces, in the DP3T / Exposure-Notification lineage), which is a fundamentally harder design — and
a proximity graph is itself re-identifying if handled carelessly (it reconstructs who-was-near-whom, i.e. a social
graph).

### 2.2 The density bootstrap

A co-location edge only forms when **two real OpenMapX users are physically near each other**. At an early user base
that is rare, and the defense is **weakest exactly when it is needed most**: low density means few honest edges to
anchor the graph _and_ few honest edges a Sybil must fail to form, so an attacker hides in the sparsity. This is the
same cold-start problem that already limits the crowd layer, but sharper — a graph defense with too few honest edges
has no signal.

### 2.3 The mobile-platform lift

Real co-location attestation is significant mobile engineering — background BLE/proximity, permissions, battery — on
top of the probe layer's already-unvalidated continuous on-device work, and hardware-backed proximity is not uniformly
available. It is not a server-side change we can ship and test headlessly.

### 2.4 It is genuinely open research

This is _why_ the crowd-reporting design files it under "funded research," not a backlog item. A
**formal** Sybil-resistance guarantee on a **sparse** co-location graph is not a bounded engineering task; the paper
proposes the direction, it does not ship a solution with proven bounds at small scale.

## 3. State of the art (2022–2026)

A 2022–2026 literature pass sharpens the picture. Every finding below points the same way: the co-location graph is
still a research direction, not a deployable component, and the field has moved toward _alternatives_.

**The co-location defense has no confirmed deployment and no published density floor.** Nobody — Waze/Google Maps
included, which were still successfully Sybil-attacked as recently as 2022 (Sybil-Based Attacks on Google Maps,
WiSec'22) — is confirmed to run it; there is no open implementation. The original paper validates only via simulation
of a _near-fully-connected_ ("mature," ~99.9% connected) proximity graph and gives **no minimum density or
co-located-pair count**. Recent citing work drifts _away_ from proximity graphs toward physical-layer signatures and
receiver-autonomous / multi-sensor cross-validation (RAIM-style). A **privacy-preserving variant** of co-location
Sybil detection for the crowdsensing setting appears to be a genuine research gap — none was found.

**Privacy-preserving proof-of-proximity primitives exist but none is turnkey.** DP3T / Google-Apple Exposure
Notification is the right shape (BLE rolling pseudonyms, _client-side_ matching so the server never builds the graph)
but is **dead as infrastructure** (wound down across 2022–2024; the repo is unmaintained) and is defeated cheaply by
BLE **relay/replay** ("teleporting" proximity). Blockchain proof-of-location schemes (FOAM, XYO, witness/anchor VANET
schemes) all need **fixed radio anchors or a witness population + a ledger** — not fieldable by a small OSS project.
The genuinely relevant primitive is **cryptographic private proximity testing** (Narayanan et al.'s DH construction;
2025 ZK "within distance X over an H3 hex grid" work with sub-second proofs) — but 2026 work
("Context-Binding Gaps in Stateful Zero-Knowledge Proximity Proofs") shows naive ZK proximity proofs are
**replayable by colluding Sybils unless bound to a session/nonce/epoch** — exactly the failure mode we would have to
defend. End-to-end, "privacy-preserving proof-of-proximity for Sybil-resistant crowdsourced conditions" is an
unsolved assembly job, not an off-the-shelf library.

**General decentralized Sybil resistance: nothing answers "distinct human" for a no-PII app.** Anonymous-credential
crypto (Privacy Pass / ARC — mature IETF RFCs, in production at Cloudflare/Apple, but no turnkey issuer) and
rate-limiting nullifiers only make token spend _unlinkable and rate-limited_; they do not prove personhood. The
proof-of-personhood options each carry heavy tradeoffs: **World ID** depends on one company's biometric orb and faces
bans or regulatory enforcement (e.g. suspensions in Kenya, Hong Kong, Brazil; GDPR orders in Bavaria); **BrightID /
Human Passport** (ex-Gitcoin
Passport) is the **lowest-friction, self-hostable, consumable** signal but is weak against cheap Sybils; Idena has
collapsed. Building native identity is a multi-year cold-start; the realistic move is to _consume_ one of these as
**one advisory signal**, never as our own gate.

**Density is the quiet killer, and there is no number to design against.** The canonical study (Viswanath et al.,
SIGCOMM 2010) shows every social-graph Sybil defense reduces to detecting one community around a trust seed, and
accuracy **"falls close to random" on fragmented/sparse graphs** (a strong reported negative correlation, ≈−0.8,
between honest-region modularity and detection accuracy). An early-stage platform _is_ the sparse regime. No paper publishes a concrete
"N users / N edges" floor; the signal is topology-dependent. The documented cold-start mitigation is to **go hybrid**
(fuse local behavioral/attribute signals with any graph signal — "defense in depth") and to **tenure-scale** trust
(start unproven accounts high-cost/low-weight and relax with proven history), _not_ to lean on the graph alone.

**Hardware attestation is a cost signal, not a personhood proof, and belongs as an advisory weight.** Play Integrity's
strong tiers **exclude de-Googled devices by design** (GrapheneOS/CalyxOS cannot pass) and are bypassable via leaked
OEM keyboxes in a continuous arms race; Apple App Attest's hardware layer is strong but is relayed at scale via
device farms; Android Key Attestation has suffered keybox leaks with no public revocation list. Both round-trip
through Google/Apple. Mature fraud/Sybil pipelines converge on treating attestation as **one weighted signal in a
broader trust score**, never a sole hard gate — which, for a privacy-first app, is both the honest choice and what
protects the GrapheneOS/jailbroken privacy audience that a hard gate would exclude.

## 4. What is buildable now — the privacy-compatible substitute

None of the following needs location data, a proximity graph, or mobile-sensor work. Together they raise the _cost_
of a Sybil without pretending to prove distinct humans — which is the honest near-term posture.

### 4.1 Device attestation as an advisory Sybil-cost weight (partly shipped)

The Attester carries a soft, composite `trust_signal`. As of the attestation-verification fix, the **attestation
component** of that signal is granted only for a **verified** attestation, not a merely-claimed one — a Sybil can no
longer buy the attestation bump with a fabricated blob (the verifier seam is in place; real Play Integrity / App
Attest / Android Key Attestation verification is a documented mobile+infra follow-on). Be honest about the rest,
though: the larger advisory components of today's `trust_signal` are **still fabricable** — `accountAgeDays` is a
self-declared client-side value (+0.4) and `osmAuth` is credited on mere presence (+0.1, "unverified"). Verifying
those is part of the same follow-on; until then, the attestation fix hardens one component, not the whole signal.
Crucially this all stays **advisory and never a gate**: a device with no attestation (e.g. a de-Googled phone)
remains fully eligible — it just carries less weight. Hardware attestation proves a _genuine,
non-emulated device with a genuine app install_, which is exactly the property a scripted Sybil fleet lacks; it does
**not** prove a distinct human, so it is a cost signal, not a personhood proof, and it carries a real
Google/Apple-dependency and de-Googled-device-exclusion tradeoff — hence advisory-only.

### 4.2 Keep the co-reporting graph monitoring-only (do NOT gate on it)

OpenConditions already computes a **co-reporting graph** (`coReportingClusters`) — distinct key-pairs that report the
same phenomenon. It is tempting to promote it to an enforcement gate, but that is **wrong on two counts**:

1. **The design forbids it.** Genuine events cluster — a real crash _is_ seen by many co-located witnesses — so a hard
   block on co-reporting would punish honest multi-witness reports. The design mandates it stay "a monitoring signal,
   never a hard block."
2. **It is a privacy step in the wrong direction.** Unlike the co-_location_ graph (which needs new location data),
   the co-_reporting_ graph reuses data we already hold — but it is still a **pseudonym-correlation graph**. _Acting_
   on it (vs. merely monitoring) starts to reconstruct who-reports-with-whom, edging toward the same social/tracking
   surface the design forbids and enabling de-pseudonymization (two keys that always co-report may be one person's two
   devices, or two people who travel together).

So the co-reporting graph stays a **reviewer-facing monitoring signal only**. That is what it already is, and it is
right to keep it there.

### 4.3 The existing cost/plausibility layers

Also already in place and worth strengthening incrementally, all without location data: the **Privacy-Pass
per-device cost gate** (Attester), **per-key + per-cell rate limits**, and **kinematic-plausibility** flagging of
impossible movement between a key's consecutive reports (a monitoring flag, not a block).

### 4.4 Optionally consume an external proof-of-personhood stamp (advisory)

Rather than build native identity (a multi-year cold-start), a future option is to _consume_ a **BrightID / Human
Passport** stamp — the lowest-friction, self-hostable proof-of-personhood signal — as **one advisory weight** in the
same trust score, opt-in and never a gate (it must not exclude a contributor who won't link an external identity).
This is the closest realistic "distinct human" signal available to a small OSS project, though it is weak against
determined cheap Sybils and adds an external dependency — hence advisory, and worth a separate design pass before
adoption. It is listed here as an option, not a commitment.

## 5. Honest limits of the substitute

The substitute raises the _cost_ of minting Sybils; it does **not** prove distinct humans. So it is **not** enough,
on its own, to safely route on corroboration or train reputation from it — those stay gated on external resolution.
The real unlock remains the co-location graph (or an equivalent proof-of-personhood), which stays behind the
privacy-preserving-proximity + density + research wall. This document exists so that the conservative default is
understood as a _deliberate, evidence-based choice_, not an oversight — and so the door is explicitly left open: the
design's "separately calibrated high-evidence policy" clause and the `applyExternalResolution("objective")` path are
already in place, so if a privacy-preserving co-location (or personhood) signal ever lands, enabling
survived-corroboration reputation or blast-radius advisory routing becomes an _additive_ change, not a rearchitecture.

## 6. Recommendation

1. **Do not build the literal co-location proximity graph now.** It is blocked by the privacy conflict (§2.1), the
   density bootstrap (§2.2), the mobile lift (§2.3), and its open-research status (§2.4).
2. **Continue the privacy-compatible substitute** (§4): finish device-attestation-as-cost (the verifier seam is in;
   real platform verification is the mobile follow-on), keep the co-reporting graph monitoring-only, and strengthen
   the existing cost/rate/plausibility layers incrementally.
3. **Keep the two high-consequence levers gated on external resolution** (routing + reputation) until a real
   distinct-humans signal exists — which is the current, deliberate posture.
4. **Revisit co-location only when** (a) a privacy-preserving proof-of-proximity design that satisfies our posture is
   identified — client-side matching only (the server never reconstructs the graph), with **strict
   session/nonce/epoch context-binding** so colluding Sybils cannot replay a proximity proof (§3) — _and_ (b) user
   density is high enough for a graph defense to have signal. Treat it, when it comes, as an opt-in layer, never a
   mandatory one.
5. **Prefer a layered advisory trust score over any single mechanism.** This is what mature Sybil/fraud pipelines
   converge on and what a privacy-first charter can actually sustain: hardware attestation (§4.1), the monitoring
   signals (§4.2), the cost/rate/plausibility layers (§4.3), and optionally an external personhood stamp (§4.4),
   combined into one advisory weight — none gating routing or reputation, which stay on external resolution.
