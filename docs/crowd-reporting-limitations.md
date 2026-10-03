# Crowd reporting: what it is, and what we do NOT promise

This page is binding and public. Crowd reporting lets pseudonymous contributors
add road-condition observations that augment the official feeds. It is a useful
signal, not a source of truth, and the honest limits below are part of the
feature — not a footnote to it. If you operate or rely on an OpenConditions
instance, read the "What we do NOT promise" section as a contract: those are
guarantees we deliberately do not make.

## What crowd reporting IS

- **An augmentation of official feeds, never a replacement.** Crowd reports sit
  beside the authoritative DATEX II / WZDx / GTFS-RT records the instance already
  ingests. They surface conditions no official feed covers yet; they do not
  overrule one.
- **Pseudonymous, signed claims.** Every report is signed by a device-held
  P-256 keypair and addressed by the RFC 7638 thumbprint of its public key. There
  is no account, phone number, or real name. A key is a pseudonym, nothing more.
- **Decay-first trust.** The primary trust mechanism is expiry, not moderation. A
  fresh report has a short lifetime and ends on its own unless corroboration or an
  external resolution extends it. Stale crowd data removes itself. Each
  situation kind (and type) the crowd may report declares its lifetime, the
  ceiling confirmations extend it to, its quorums and its match distance in the
  registry (`crowd` rules, `crowdRulesFor`); the evidence math is in
  [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts).
- **Readings as well as situations.** A contributor can also report a
  reading of something an instance already knows: a charge point out of order,
  the price on a station's pole, how full a car park is. The reading sits
  beside the operators' own readings of the same thing and never replaces a
  fresh one: the value an instance shows (its fused row) prefers a fresh feed,
  and shows a crowd reading only while the feed is stale or silent. A reading
  is accepted only from someone standing within the property's reach of the
  subject, and only about a subject the instance holds; where the reporter
  stood is checked and then dropped. Crowd readings stay on the instance that
  took them: they are not federated.
- **Corroboration plus an external-resolution ladder.** Independent reports can
  corroborate one another, and only an external resolution (an official match, a
  reviewer decision, or an objective measurement) promotes a phenomenon to
  routing-eligible. Peer agreement alone never routes.

## What we do NOT promise (the binding list)

- **We do NOT prevent coordinated false reports.** A group that cooperates to
  file matching reports can manufacture apparent corroboration. Corroboration is
  a weak signal by design; it is never treated as proof.
- **We do NOT prove one-report-one-human.** Nothing here establishes that a key,
  or a cluster of keys, maps to a distinct real person.
- **We do NOT offer Sybil-resistant anonymous reputation.** An adversary who can
  mint keys can mint reputation-bearing identities. Collusion remains an unsolved
  problem in the literature — the "Ghost Riders" analysis of crowd-traffic
  spoofing is still the state of the art, with no meaningful advance since 2018.
- **We do NOT keep two different readings of one moment.** Two contributors
  reporting the same subject at the same instant with different values cannot
  both be right; the second is refused, and the first stands until evidence or
  a feed settles it.
- **Attestation is a soft advisory signal, never a gate.** Optional device
  attestation nudges a score at most. Privacy-OS, de-Googled, and F-Droid users
  fail attestation _by design_, so it can never be load-bearing: a report is
  never accepted or rejected because attestation passed or failed.

## The trust model, honestly

Evidence moves through explicit states:

`self_reported → corroborated → externally_resolved` (or `negated` / `expired`).

| Stage                        | Map-visible    | Routes? | Trains reputation? |
| ---------------------------- | -------------- | ------- | ------------------ |
| First report                 | Yes, short-TTL | No      | No                 |
| ≥2 distinct keys corroborate | Yes            | No      | No                 |
| Externally resolved          | Yes            | Yes     | Yes                |
| Negated / expired            | Removed        | No      | No                 |

The rules this table encodes are strict on purpose: the first report is
map-visible but short-lived and **non-routing**; two or more _distinct_ keys can
corroborate but corroboration alone still **never routes and never trains
reputation**; only an external resolution both routes the phenomenon and trains
the originating (and pre-resolution confirming) reporters' reputation. Reputation
itself is **advisory** — see below.

## Reputation is advisory

Each reporter carries a Beta reliability posterior trained _only_ by external
resolutions. The `GET /contrib/reporter/me` route exposes a contributor's own
one-sided lower credible bound. It is framed exactly as what it is: an advisory
number, **not a probability that any given report is true and not a
Sybil-resistance guarantee**. It informs display and ranking; it never gates
publication.

## Privacy posture

- **Device-keypair pseudonymity.** No phone number, no real name, no account.
- **Per-record privacy class.** Every crowd record carries the
  `crowd_pseudonym` privacy class; the reporter's key rests in its provenance
  and is stripped at every egress (API, emitters, federation, archive).
- **Probe/speed data is a separate, later, gated layer.** Continuous
  speed/flow contribution (with distributed aggregation and differential privacy)
  is out of scope here and is not covered by this page.
- **Police presence is OFF by default.** The crowd cannot report police
  presence at all under the production registry: the `authority` kind
  (`authority.operation`, with the `police_checkpoint` and `police_activity`
  subtypes) declares no crowd rules, so such a claim fails validation. As
  defense in depth, an instance whose registry lets the crowd report it still
  lands a police-presence report only when an operator explicitly sets
  `OPENCONDITIONS_ALLOW_POLICE_CATEGORY=true`. Other authority activity (customs,
  enforcement, weighing, …) is not gated. See
  [`services/contributions-api/src/policy/police.ts`](../services/contributions-api/src/policy/police.ts).

## Anti-abuse

- **Rate limits per key and per area.** A key is capped both overall and per
  ~1 km cell within a short window.
- **Kinematic plausibility is a post-hoc flag, not a pre-publish block.** A
  physically impossible reporter transition flags the new report for review;
  it does not censor it, because a truthful fast mover must not be silenced.
- **Post-hoc reviewer revert, no pre-publish moderation queue.** Nothing gates
  before publication. Reviewers act after the fact — accept, reject, or block.
- **Operator block lists are local and never auto-federated.** An instance's
  block decisions stay on that instance; they are never automatically propagated
  across the federation.

## Media

v1 accepts **no media**. There is no upload path, no server-side image storage,
and no redaction pipeline. A claim is a strict model claim: a field the model
does not define (a `media` or `photo` key included) is refused at verification.
Media is deferred pending a separate retention and redaction review.

## Cross-references

- The commons substrate (identity, evidence, privacy columns) is documented in
  [`commons-substrate.md`](commons-substrate.md), including the evidence policy
  and the evidence/reputation functions this page relies on.
- The evidence-state machine and the reliability posterior math live in
  [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts); the crowd
  lifetimes and quorums are the registry's crowd rules (see `docs/model.md`).
