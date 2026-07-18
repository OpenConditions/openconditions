# Federation onboarding — registry, TUF trust model, and peering

This page is the operator's guide to joining (or admitting a peer into) the
OpenConditions federation. It covers the registry entry format, the TUF-signed
trust model that secures registry distribution, the bilateral pinned-key
bootstrap that works **without** any registry, a sample peering MoU, and the
governance-review process. Read it together with
[federation-gdpr.md](./federation-gdpr.md), which frames what the deletion and
data-protection machinery does and does not guarantee.

> **Status — read this first.** The machinery below (registry schema, TUF
> signing/verification, daily sync, bilateral bootstrap) is built and tested in
> CI against a **TEST trust root**. The following are deliberately **not** done
> and require human/organizational action before any live federation:
>
> - no external public registry repository exists yet;
> - no production trust root exists — that requires an **offline key ceremony**
>   with the reviewed 2-of-3 governance threshold;
> - no real peer has been admitted and live exchange is not enabled — that
>   requires a signed MoU/DPA and an out-of-band key exchange.

## 1. The registry entry

The federation registry is a set of YAML files, one per instance, each named
`<id>.yaml` after the entry's `id`:

```yaml
id: openmapx-de
actor: https://de.example.org/.well-known/openconditions/actor.json
operator:
  name: OpenMapX DE e.V.
  contact: federation@de.example.org
  jurisdiction: DE
coverage:
  iso3166: [DE]
  bbox: [5.8, 47.2, 15.1, 55.1]
trustTier: 1
keys:
  - z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

Field rules (enforced by `parseRegistryEntry` in
`packages/federation/src/registry.ts`, which fails closed on anything
malformed):

| Field       | Meaning                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `id`        | Lowercase slug (`[a-z0-9-]`). Doubles as the TUF target file name, so no dots, slashes, or case games.      |
| `actor`     | The instance's Actor document URL (`/.well-known/openconditions/actor.json`).                               |
| `operator`  | Legal operator: `name`, `contact`, `jurisdiction` (all required).                                           |
| `coverage`  | `iso3166` country codes and/or a `[minLon, minLat, maxLon, maxLat]` bbox.                                   |
| `trustTier` | 0 (observer), 1 (standard), or 2 (anchor) — governs peering scope; admission is the governance review (§5). |
| `keys`      | The instance's **authorized Ed25519 keys** as `publicKeyMultibase` (`z6Mk…`) values.                        |

### Ed25519 key authorization

The `keys` list is the registry's trust statement about an instance. At
runtime, a key served in a peer's Actor document is trusted **only if** it
matches the operator's out-of-band bilateral pin **or** appears in the
TUF-verified registry entry for that instance (`registryToPeerRecords` maps
`keys` into the peer record's `pinnedKeys`, and `verifyActorAgainstPin`
enforces the match). A key that is merely _served_ by an actor but anchored
nowhere is never trusted — key substitution and rollback to retired keys are
rejected.

## 2. The TUF trust model

The registry files are distributed as targets of a [TUF (The Update
Framework)](https://theupdateframework.io/) repository. Verification uses the
maintained `tuf-js` client and `@tufjs/models` — the TUF client workflow is
never hand-rolled in this codebase.

What TUF gives the registry:

- **Signed, thresholded roles.** `root.json` names the keys and signature
  thresholds for every role; `targets.json` signs the registry files
  themselves; `snapshot.json` binds the exact targets version and hashes;
  `timestamp.json` proves freshness.
- **Rollback protection.** A client remembers the metadata versions it has
  seen (its cache directory) and rejects any sync that serves a lower version.
- **Freeze protection.** `timestamp.json` has a short expiry; replaying stale
  metadata past that expiry is rejected, so an attacker cannot indefinitely
  serve an old (but once-valid) registry.
- **Expiry.** Every role's metadata carries an expiry and expired metadata is
  rejected.
- **Mix-and-match protection.** Snapshot pins the version, length, and hashes
  of targets metadata; combining files from different releases is rejected.
- **Unauthorized-key and threshold enforcement.** Metadata signed by a key the
  root did not authorize, or by fewer keys than the role's threshold, is
  rejected.
- **Tested key rotation.** A new root signed under **both** the old root's
  threshold and its own is accepted by existing clients; a rotation that does
  not satisfy the old threshold is rejected. This is exercised in CI
  (`packages/federation/src/__tests__/tuf-registry.test.ts`).

### Honesty about what secures what

- **TUF secures the registry _update channel_** — that the registry files you
  fetched are the ones the registry governance signed, fresh, and not rolled
  back. It does not make an entry's _contents_ true; admitting an instance is
  the governance review's job (§5).
- **Git history alone is not a secure update protocol.** Commit history,
  GitHub organization permissions, or a TLS connection to a forge do not
  provide rollback/freeze protection or signature thresholds. The registry
  repository may _live_ in git, but clients must only trust what the TUF
  metadata verifies.
- **The production root does not exist yet.** Everything in-repo runs against
  a TEST root generated in CI. A production deployment requires:
  - an **offline root key ceremony**: root keys generated and stored offline
    (hardware tokens or air-gapped storage), never on a federation server;
  - the **reviewed 2-of-3 governance threshold**: three root key holders, two
    signatures required for any root change, with the holder list reviewed by
    federation governance;
  - out-of-band distribution of the initial `root.json` to operators (shipped
    with the software or exchanged at peering time — never fetched blindly
    from the registry itself).

### The TEST root is refused in production (fail-closed)

Every root generated by this repository's release tool (`signRegistry`)
carries the marker field `x-openconditions-test-root: true`. The verification
client (`verifyRegistryMetadata`) refuses a marked root — both the configured
trust root and anything already persisted in its cache — and the gate **fails
closed**: a test root is accepted **only** when the environment is _explicitly_
dev/test (`NODE_ENV` in {`development`, `test`}) or the caller passes an
explicit `allowTestRoot: true` opt-in. An unset, unknown, or `production`
`NODE_ENV` all **refuse** the test root, throwing `TestRootInProductionError`
before any metadata is fetched. A deployment that simply _forgets_ to set
`NODE_ENV` therefore cannot silently run on CI trust material — it must be
provisioned with a ceremony-produced (unmarked) root.

This is an accidental-misuse guard, not a boundary against a forged production
root: an attacker who can mint metadata would simply omit the marker. The real
security is the offline 2-of-3 root ceremony below.

## 3. Bilateral pinned-key bootstrap (no registry required)

The first one or two peerings do not need a registry at all. Bootstrap trust
is a **bilateral, out-of-band exchange of key fingerprints**, recorded in the
signed MoU (§4) and in each operator's peers configuration:

1. Each operator reads their instance's `publicKeyMultibase` values (the
   `z6Mk…` strings served in their own Actor document).
2. The operators exchange these fingerprints over an authenticated channel
   (the signed MoU itself, a video call with verbal confirmation, signed
   email — anything both sides consider authenticated) and record them in the
   MoU's key-exchange annex.
3. Each operator pins the other's fingerprints in their peers config
   (`pinnedKeys` in the T1 peer record). The pin is the trust anchor: a
   fetched Actor document is trusted only if it serves a pinned key at the
   pinned URL.
4. Runtime message authenticity is then proven per-request by RFC 9421 HTTP
   message signatures under a pinned key — the pin proves key _listing_, the
   message signature proves _possession_.

The TUF registry becomes the **scaled** trust anchor later: once an instance
is in the verified registry, its registry `keys` are merged into the pinned
set (`mergePeerRecords`), so a runtime key is trusted if it matches the
bilateral pin **or** chains to a TUF-authorized key. The operator's own
bilateral configuration always outranks registry-discovered values.

## 4. Sample peering MoU

A template for the out-of-band agreement two operators sign before enabling
live exchange. It is a sample, not legal advice; each operator should have it
reviewed under their own jurisdiction. Cross-reference
[federation-gdpr.md](./federation-gdpr.md) for the honest framing of what the
technical deletion machinery can and cannot promise.

> ### Memorandum of Understanding — OpenConditions federation peering
>
> Between **[Operator A, legal name, address, jurisdiction]** ("A") and
> **[Operator B, legal name, address, jurisdiction]** ("B"), together "the
> parties".
>
> 1. **Purpose.** The parties operate OpenConditions instances
>    (`[instance-id-a]`, `[instance-id-b]`) and agree to exchange road- and
>    traffic-condition events (including signed tombstones and metadata
>    events) to improve coverage for their users. No other data categories are
>    exchanged under this MoU.
> 2. **Data categories and lawful basis.** Exchanged events describe road
>    conditions, not persons. Where an event or its provenance chain could
>    contain personal data (e.g. a reporter-attributed observation), each
>    party documents its lawful basis for onward sharing before enabling the
>    relevant event types.
> 3. **GDPR controller-role assessment.** The parties assess and record, per
>    Art. 26/28 GDPR, whether they act as independent controllers (the default
>    assumption for federated instances, each determining its own purposes),
>    joint controllers for any jointly determined processing, or in a
>    controller–processor relationship for any specific service. If any
>    exchanged category contains personal data, the parties conclude the
>    corresponding agreement (joint-controller arrangement or DPA) **before**
>    live exchange.
> 4. **Retention.** Each party applies its own documented retention schedule
>    to received events; federated TTL (`expiresAt`) and tombstone
>    propagation are technical minimisation measures, not the legal retention
>    decision (see federation-gdpr.md).
> 5. **Privacy and rights handling.** Each party names a contact
>    (`[privacy@…]`) for data-subject requests. A rights request affecting
>    federated data is routed along the provenance chain to the originating
>    instance; the receiving party honours signed `gdpr_erasure` tombstones
>    from its peer without undue delay and confirms application. Both parties
>    acknowledge tombstone propagation is best-effort evidence of a
>    good-faith technical step, not proof that every copy is gone.
> 6. **Security and key exchange.** The parties exchange their instances'
>    Ed25519 `publicKeyMultibase` fingerprints in Annex 1 over an
>    authenticated channel and pin them bilaterally. Key rotations are
>    announced at least [14] days in advance through the signed key-rotation
>    event and confirmed out-of-band; a suspected key compromise is reported
>    to the other party within [24] hours and the affected pins removed
>    immediately.
> 7. **Service expectations.** Exchange is best-effort; neither party
>    guarantees availability. Rate limits and capability negotiation follow
>    the federation protocol. Abuse-resistance actions (rate downgrades,
>    blocklisting) taken in good faith are not a breach of this MoU.
> 8. **Attribution and licensing.** Exchanged data carries source attribution;
>    each party preserves upstream attributions and licence obligations when
>    re-publishing.
> 9. **Termination.** Either party may terminate with [30] days written
>    notice, or immediately on material breach or key compromise. On
>    termination the parties remove each other's pins, disable subscriptions,
>    and each applies its documented retention/deletion schedule to already
>    received data.
> 10. **Review.** The parties review this MoU on peering changes (new event
>     categories, tier changes) and at least every [12] months.
>
> **Annex 1 — key exchange.**
> Instance `[instance-id-a]`, actor URL `[…]`, pinned keys: `z6Mk…`, `z6Mk…`.
> Instance `[instance-id-b]`, actor URL `[…]`, pinned keys: `z6Mk…`.
>
> Signed: [name, role, date] / [name, role, date]

## 5. Governance review — how an instance enters the registry

Admission to the shared registry is an organizational process on top of the
technical machinery:

1. **Application.** The candidate operator submits their registry entry (the
   YAML of §1) plus: operator identity evidence, the instance's public actor
   URL, and at least one existing federation operator willing to vouch (for
   tier 1+).
2. **Review.** Registry maintainers verify: the actor document is served at
   the stated URL and lists the stated keys; the operator contact answers;
   coverage claims are plausible; the MoU/DPA position of §4 item 3 is
   documented for the data categories the instance wants to exchange.
3. **Signing.** On approval, the entry lands in the registry and a new release
   is signed: `targets.json`/`snapshot.json`/`timestamp.json` are re-signed
   with the online release keys (`signRegistry` is the release procedure).
   Changes to the **root** (key holders, thresholds) additionally require the
   offline 2-of-3 root ceremony.
4. **Distribution.** Peers pick the change up on their daily registry sync
   (`syncRegistry`, `REGISTRY_SYNC_INTERVAL_HOURS = 24`) — deliberately a slow
   catalog cadence, distinct from the 30–60 s live-outbox polling. A failed
   verification never degrades a peer set: clients keep their previous peers
   and alert.
5. **Removal / demotion** follows the same path (review → re-sign → daily
   sync), and is exactly why freeze protection matters: a removed instance
   cannot keep replaying the registry release that still contained it beyond
   the timestamp expiry.

## 6. Remaining human/organizational steps (deliberately not automated)

- Create the external public registry repository and host its TUF metadata.
- Perform the production root key ceremony (offline, 2-of-3, reviewed
  holders) and distribute the initial `root.json` out-of-band.
- Negotiate, review, and sign the first real MoU/DPA and exchange keys with
  an actual peer operator.
- Only then: configure the peer, enable live exchange, and schedule the daily
  registry sync against the production registry.
