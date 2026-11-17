# Federation onboarding — registry, TUF trust model, and peering

This page is the operator's guide to joining (or admitting a peer into) the
OpenConditions federation. It covers the registry entry format, the TUF-signed
trust model that secures registry distribution, the bilateral pinned-key
bootstrap that works **without** any registry, a sample peering MoU, and the
governance-review process. Read it together with
[federation-gdpr.md](./federation-gdpr.md), which frames what the deletion and
data-protection machinery does and does not guarantee.

What instances send each other, and how they sign and check it, is specified in the [federation wire protocol](./federation-protocol.md).

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

| Field       | Meaning                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | The instance's id, its `OPENCONDITIONS_INSTANCE_ID` (`[a-z0-9.-]`), which its records carry. Doubles as the TUF target file name, so no slashes or case games. |
| `actor`     | The instance's Actor document URL (`/.well-known/openconditions/actor.json`).                                                                                  |
| `operator`  | Legal operator: `name`, `contact`, `jurisdiction` (all required).                                                                                              |
| `coverage`  | `iso3166` country codes and/or a `[minLon, minLat, maxLon, maxLat]` bbox.                                                                                      |
| `trustTier` | 0 (observer), 1 (standard), or 2 (anchor) — governs peering scope; admission is the governance review (§5).                                                    |
| `keys`      | The instance's **authorized Ed25519 keys** as `publicKeyMultibase` (`z6Mk…`) values.                                                                           |

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
- **A second implementation.** The CI `interop` job runs
  `scripts/tuf-interop/check.sh`: python-tuf 7.0.1 (hash-locked in
  `scripts/tuf-interop/requirements.txt`, installed into a disposable
  environment) reads repositories `signRegistry` writes, and
  `verifyRegistryMetadata` reads repositories python-tuf's Metadata API writes.
  Both directions cover a valid release, a 2-of-3 threshold met and missed, root
  rotation with and without the old root's signatures, expiry, snapshot and
  target tampering, and rollback against a retained cache. Run it locally with
  Python 3.14 after `pnpm build`.

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
bilateral configuration always outranks registry-discovered values. A peer
only the registry names is served the public tier (Tier 0) whatever its entry
states; a wider window is granted by configuring the peer.

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
>    contain personal data (e.g. a crowd report), each
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
>    instance; the receiving party honours signed `rights_revoked` tombstones
>    from its peer without undue delay and confirms application. Both parties
>    acknowledge tombstone propagation is best-effort evidence of a
>    good-faith technical step, not proof that every copy is gone.
> 6. **Security and key exchange.** The parties exchange their instances'
>    Ed25519 `publicKeyMultibase` fingerprints in Annex 1 over an
>    authenticated channel and pin them bilaterally. Each instance rotates its
>    key every six months, the old key endorsing the new one, which the other
>    party's instance follows without a new pin; a suspected key compromise is
>    reported to the other party within [24] hours and the affected pins
>    removed immediately.
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

## 7. Running the federation service

The federation service (`services/federation`, port 4300) is off until
`OPENCONDITIONS_FEDERATION_ENABLED=true`. Enabled, it fails its boot on any of
these not being right:

| Variable                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCONDITIONS_INSTANCE_ID`            | This instance's id, the one the ingest and contributions services stamp on every record. It must equal the actor's `instanceId`: a peer admits only records of the instance it pinned.                                                                                                                                                                                                                                                                                |
| `OPENCONDITIONS_FEDERATION_ACTOR`       | The actor config (inline JSON or a path): `instanceId`, `baseUrl` (the public origin peers reach the service at), operator, coverage, licence, tier, and the capabilities the operator states: `protocolVersion` (optionally `protocolVersions`) and `convergenceBound`. The schema versions, wire format, delivery modes and filter keys are advertised from the running build, and configuring them, `maxEventRate` or an actor-wide `mtlsRequired` fails the boot. |
| `OPENCONDITIONS_FEDERATION_PEERS`       | The peers config (inline JSON array or a path): one record per peer with its `instanceId`, `actorUrl`, `trustTier` and `pinnedKeys` (§3), and none naming this instance.                                                                                                                                                                                                                                                                                              |
| `OPENCONDITIONS_FEDERATION_ARCHIVE_URL` | Where peers fetch the static archive (default `<baseUrl>/archive`, which the operator serves; see [archive.md](./archive.md)).                                                                                                                                                                                                                                                                                                                                        |

Optional:

| Variable                                       | Meaning                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCONDITIONS_FEDERATION_REGISTRY_URL`       | A federation registry (TUF metadata under `/metadata`, entries under `/targets`) whose verified instances join the peers, daily (§5). Needs `…_REGISTRY_ROOT`.                                                               |
| `OPENCONDITIONS_FEDERATION_REGISTRY_ROOT`      | The registry's trusted `root.json`, obtained out of band (inline JSON or a path).                                                                                                                                            |
| `OPENCONDITIONS_FEDERATION_REGISTRY_CACHE`     | Where verified registry metadata is kept between syncs, for rollback protection (default `./data/registry`; `/data/registry` on the service's volume under OpenMapX).                                                        |
| `OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER` | For peers with `mtlsRequired` behind a TLS-terminating proxy: the header the proxy puts a verified client certificate's SHA-256 fingerprint in (see _Mutual TLS_ below).                                                     |
| `OPENCONDITIONS_FEDERATION_CLIENT_CERT_FILE`   | A PEM client certificate this instance presents on every request to a peer, for peers that require mutual TLS of it (see _Mutual TLS_ below). Needs `…_CLIENT_KEY_FILE`.                                                     |
| `OPENCONDITIONS_FEDERATION_CLIENT_KEY_FILE`    | The PEM private key of that certificate. Both files are read once at boot; one without the other, an unreadable file or a key that is not the certificate's fails the boot.                                                  |
| `OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES`    | Comma-separated addresses or subnets (`10.0.0.2`, `172.18.0.0/16`) of the reverse proxies in front of the service. Only from them are `X-Forwarded-For` and the client certificate header believed (see _Mutual TLS_ below). |
| `OPENCONDITIONS_EGRESS_ALLOWED_HOSTS`          | Comma-separated host names the service may reach although they resolve to private addresses: a peer, archive or inbox on the same private network. Every other private, loopback or link-local address is refused.           |
| `OPENCONDITIONS_FETCH_TIMEOUT_MS`              | How long a request to a peer may take (default 60000). A peer's archive files have an hour each.                                                                                                                             |
| `OPENCONDITIONS_MAX_REDIRECTS`                 | How many redirects a request to a peer follows (default 5); each hop is checked as the first.                                                                                                                                |

A peer record with `subscribe` makes this instance a subscriber of that peer:

```json
{
  "instanceId": "openmapx-de",
  "actorUrl": "https://de.example.org/.well-known/openconditions/actor.json",
  "trustTier": 1,
  "pinnedKeys": ["z6Mk…"],
  "subscribe": {
    "filter": {
      "classes": ["situation", "observation"],
      "kinds": ["closure", "incident", "roadworks"],
      "properties": ["traffic.los", "charging.evse_status"],
      "bbox": [5.8, 47.2, 15.1, 55.1],
      "sourceLiveness": true
    },
    "priorityOnly": false
  }
}
```

At boot and hourly after, the service verifies each peer's actor document
against its pin, keeps what schemas it runs, and makes sure each peer it
subscribes to holds a webhook subscription pushing to this instance's
`<baseUrl>/peer/inbox` with that filter: it creates one, patches one whose
filter differs, and re-enables one the peer disabled after failed deliveries.
The peer advances its cursor only over pages this inbox accepted, so a push
resumes where it stalled. The filter must be one a peer pushes: bounded (a
bbox, kinds, domains, properties, privacy classes or a maximum age), naming
the properties of any observations, and, with `properties`, naming the kinds
of the situations, features and offers it wants. `sourceLiveness` asks for the
liveness of the peer's sources, so their unchanged readings stay current
here. The subscription is not served in the public peers document.

Both operators must pin each other: a peer accepts a subscription only from an
instance it pinned, and this instance's inbox accepts a push only from one.
Removing `subscribe` leaves the subscription at the peer; the peer's operator,
or a signed `DELETE /peer/subscriptions/<id>`, ends it.

A subscription is a lease of 30 days (`expiresAt` in every subscription answer), and every accepted `PATCH` renews it, one that changes nothing included. The hourly upkeep patches a matching subscription once 15 days or less of its lease remain, so an instance that runs keeps its subscriptions without anyone noticing. A subscription that is not renewed stops being pushed, is no longer shown to its peer and is deleted within the hour, so an instance that went away stops having the peer journal for it. An instance that was away longer than the lease finds no subscription at the peer on its return: its upkeep subscribes again, the peer's journal seed journals what the new subscription wants, and a pull that was away longer than its window starts from the peer's archive.

A peer record with `pull` (`"pull": { "filter": { … } }`) has the service read
the peer's journal itself, every 30 seconds, with its own cursor
(`conditions.federation_peer_cursor`): complete whatever the push carries, so
a `"priorityOnly": true` push for closures and incidents can sit beside a pull
for the rest. The service keeps a `pull` subscription with that filter at the
peer, since a peer journals only what some subscription wants. Each page is
a signed request, served the peer's window for this instance's tier, and must
carry the peer's signature under a pinned key. A cursor still catching up
reads `/peer/backfill`, the live tail `/peer/outbox`. A pulled page is checked as a pushed one is: nothing is asked of a blocked peer, a page holds at most the entries asked for (500, or fewer for the rest of a pull that met a page over 1 MiB) and 1 MiB, and arrives within 60 seconds; its entries
must lie after the cursor asked for and up to its own high-water mark, and a
page that moves the cursor nowhere ends the pull. The pull is not metered here and draws nothing on the budget the inbox meters the peer's pushes with: the peer meters it against the journal-read budget of this instance's tier, and a peer that answers `429`, or `503` with a `Retry-After`, is not asked again before that time has passed. Each round reads pages from each peer for up to 20 seconds while it has more; while any peer has more left, the next round starts at once instead of 30 seconds later. A page lands through
the same inbox as a pushed one, and advances the cursor only once it landed;
what both the push and the pull deliver lands once (the second delivery is
`stale`), and a retraction carries the revision the record ended at, so one
that arrives after a later change leaves the change. History before the
window lives in the peer's archive: a page that says the cursor is beyond the
window names the archive's files with their SHA-256 in its signed body, and
the service lands those first, checked against the page, then the page (see
[archive.md](./archive.md)). A new peer, or one away longer than its window,
starts so; an archive is landed once per night it was built, and not within a
day of the last.

### Keys and rotation

The service creates its Ed25519 instance key on first boot and keeps it in
the database. A key is valid for six months; 30 days before it expires the
service rotates it: the old key endorses the new one (both sign that the new
key is this instance's next), and the actor document serves both, with the
endorsement, until the old one expires. The new key signs only once it has
been served for a week, so every peer has read it. A peer trusts a served key
that a key it pins, or learned this way, endorsed, and keeps it
(`conditions.federation_peer_key`): operators pin each other once, and the
pins carry through every rotation. A learned key is trusted only while the pin
it leads back to stays configured, so removing a pin revokes what it led to.
A peer that does not read the actor document for longer than a key lives (six
months) has to be pinned again. A key pinned for two peers fails the boot.

### One process

Run one federation service per database. Its replay cache, rate limits and
the single flight of its pull, push and upkeep are its own, so it holds a
database advisory lock while it runs: a second one (a replica, or a new
container started before the old one stopped) waits until the first ends,
and one that loses the lock's connection stops. A peer holds one pull
subscription and one webhook per inbox here; a second is refused with `409`
naming the one held, which the peer patches.

### Restoring or moving the database

A journal cursor is a pair of a Postgres transaction id and a sequence number, so it only means something within one history of the database. The journal's epoch (`conditions.federation_journal`, one row) names that history, and every page of the outbox and backfill states it. When the epoch changes, the journal is emptied of everything but its delete entries, every push cursor goes back to the start, and the journal seed journals the current records again for the subscriptions that exist. The deletes are kept, erasures included, because nothing would journal them again and a subscriber may not have read them yet. A subscriber that sees the new epoch reads the journal again from the start: the deletes first, then what is live, landing what it already holds as stale.

The service starts a new epoch by itself at boot when transaction ids went back, which is what a logical restore (`pg_dump` and `pg_restore`, or a move to another server that way) does, and when the Postgres timeline changed, after point-in-time recovery or a promotion. Nothing in the database says that it was rolled back from a filesystem snapshot or an older base backup: after such a restore, run `DELETE FROM conditions.federation_journal;` before starting the service, and it starts a new epoch. A subscriber that asks with a cursor the restored journal has not reached is told so (`cursorAhead`) and starts again from the beginning too, as does a push cursor that is ahead. A new epoch that was not needed, for example after `pg_upgrade` of a cluster that was once promoted, costs one re-read of the journal by each subscriber and is otherwise safe.

A restore takes the records back as well. A subscriber cannot learn from the journal what the restored history no longer has (records created after the backup, versions it took later, its withdrawals), and a subscriber away longer than its window learns from neither the archive nor the journal what the publisher ended meanwhile. So after reading a journal that started over, and after a page said its cursor was beyond the window, a subscriber compares its copies with the publisher's present state (`GET /peer/state` and `POST /peer/records`, see the [protocol](./federation-protocol.md#the-publishers-record-state)) once its pull reached the live tail (after a beyond-window page only when none is due already and the last one finished more than a day ago; a journal that started over always starts one over). It replaces each copy that differs with the publisher's version, even at the same or a lower revision, ends what the publisher ended (an erasure as an erasure), gets what it was missing, and ends as `withdrawn` each copy of a record the publisher no longer knows. A copy that changed after the comparison began, or one this instance rejected or superseded, is left as it is. The comparison runs in slices of 20 seconds between pulls, stores how far it got after every page so it resumes after a restart, and logs one line when it finishes: `[federation-api] reconcile of <peer>: <n> compared, <n> updated, <n> restored, <n> ended, <n> retired, <n> refused`. It needs a peer whose negotiated protocol version is 0.3 or later; against an older one it stays due and the service says so once a day. An operator can ask for one, for example after repairing data by hand, with `UPDATE conditions.federation_peer_cursor SET reconcile_due_since = now(), reconcile_class = NULL, reconcile_after = NULL WHERE peer_instance_id = '<peer>';`.

Erasures made after the backup are undone by restoring it: the erased record and the missing erasure fact both come back from the backup. Repeat those erasures before starting the service. Subscribers that received an erasure keep refusing the record for the 30 days their erasure fact lasts, but accept it again after that, so an erasure not repeated at the publisher is undone everywhere in the end.

### Journal lag

A page serves only entries that no older transaction can still precede, so a write transaction that stays open anywhere on the Postgres server holds back every entry committed after it began. The service checks this every minute and logs a warning while entries have been held back longer than the actor's `convergenceBound`, naming the application whose transaction is open when its role may see it, and one line when the lag is gone. `GET /status/journal` answers the epoch, when the oldest held-back entry was journalled (`heldSince`, null when none is) and how many seconds ago (`lagSec`). `/status` stays the container health check and does not include it.

### Peers on a private network

Requests to peers, their archives and their inboxes go through the egress
guard: a host that resolves to a private, loopback or link-local address is
refused, also after a redirect. A peer on the same private network (a second
instance of one operator, or a test pair) is reached by naming its host in
`OPENCONDITIONS_EGRESS_ALLOWED_HOSTS`, on each side that reaches the other.
A webhook inbox must otherwise be public https; one on the subscribing peer's
own host (that of its `actorUrl`), named there, may be private and plain http,
like the service's other requests to that host. An inbox on any other host
named there is refused.

### Mutual TLS

A peer record with `"mtlsRequired": true` (and optionally
`"mtlsFingerprints": ["AB:CD:…"]`) must, besides its signature, arrive over
TLS with a client certificate that was verified. Where a reverse proxy
terminates TLS, the proxy verifies the certificate and passes its fingerprint
on in a header the service is told of with
`OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER`. The header is believed as it
arrives, so the proxy must set it itself, whatever the client sent, and must
be the only way to the service. With Caddy:

```text
maps.example.org {
	tls {
		client_auth {
			mode verify_if_given
			trust_pool file /etc/caddy/peer-ca.pem
		}
	}
	handle /peer/* {
		reverse_proxy openconditions-federation:4300 {
			header_up X-Client-Cert-Sha256 {http.request.tls.client.fingerprint}
			flush_interval -1
		}
	}
}
```

and `OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER=X-Client-Cert-Sha256`.
The `header_up` line replaces whatever the client sent in that header with Caddy's own value, so a client cannot name a certificate itself; do not add a `header_up -X-Client-Cert-Sha256` line to delete it first, as Caddy applies the delete after the set and the service then never sees the header.
Behind a proxy, every peer with `mtlsRequired` must pin `mtlsFingerprints`
(the boot fails otherwise), and a header sent twice names no certificate.
For a connection without a client certificate Caddy's fingerprint is the SHA-256 of empty input (`e3b0c442…b855`), which the service reads as no certificate too, so such a request is refused with `mtls-required`.
`OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES` (comma-separated addresses or subnets, `172.18.0.0/16`) takes the header only from those, so another container on the network cannot set it. It is not tied to mutual TLS: an unsigned `/peer/outbox` read is rate limited at tier 0's budget per client address (an IPv6 address by its /64 prefix), and the service takes that address from `X-Forwarded-For`, which Caddy's `reverse_proxy` sets, only on a connection from one of these proxies. Without the setting, every anonymous reader behind a proxy is metered as the proxy's one address.
Fingerprints match however they are written (`AB:CD:…` or `abcd…`). A peer
without `mtlsRequired` is unaffected; mTLS never replaces the signature.

For a peer that requires mutual TLS of this instance, set `OPENCONDITIONS_FEDERATION_CLIENT_CERT_FILE` and `OPENCONDITIONS_FEDERATION_CLIENT_KEY_FILE` to a PEM certificate and its key. The service then presents that certificate on every request it sends to a peer: its pulls, the comparison of copies, the webhook pushes, the subscription upkeep, the capability refresh and the archive downloads. The registry is fetched without it. The certificate must be one the peer's proxy trusts, and its SHA-256 fingerprint (`openssl x509 -in client.pem -noout -fingerprint -sha256`) is what the other operator pins in `mtlsFingerprints`.

### Deploying it

The image is `ghcr.io/openconditions/federation`, built from
`services/federation/Dockerfile` and published with every release. It is not
part of the OpenMapX extension (`extension.json`): OpenMapX would start it on
every install, and gives a community service no public route, so it could
reach no peer and no peer could reach it. An operator who federates runs it
beside the extension's services, on the same database, and routes three
public paths of the actor's `baseUrl` to it and to the archive:

| Public path                    | Served by                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `/.well-known/openconditions/` | the federation service, port 4300: the actor document and the declared peers             |
| `/peer/`                       | the federation service: outbox, backfill, subscriptions, stream and inbox                |
| `/archive/`                    | the files of the ingest service's archive directory (`/data/archive` on its data volume) |

The service signs and verifies against its configured `baseUrl`, not the
request's host, so the proxy may rewrite the host but not the path. The
stream (`/peer/stream`) is server-sent events: the proxy must not buffer it.
With an OpenMapX install, a compose file beside it adds the service to the
same network:

```yaml
services:
  openconditions-federation:
    image: ghcr.io/openconditions/federation:latest
    restart: unless-stopped
    environment:
      # The ingest service's own role, never the PostgreSQL superuser.
      DATABASE_URL: postgresql://openconditions_ingest:${OPENCONDITIONS_INGEST_DB_PASSWORD}@postgis:5432/openmapx
      OPENCONDITIONS_INSTANCE_ID: maps.example.org
      OPENCONDITIONS_FEDERATION_ENABLED: "true"
      OPENCONDITIONS_FEDERATION_ACTOR: /config/actor.json
      OPENCONDITIONS_FEDERATION_PEERS: /config/peers.json
      OPENCONDITIONS_FEDERATION_REGISTRY_CACHE: /data/registry
      TMPDIR: /data
    volumes:
      - ./federation:/config:ro
      - openconditions-federation-data:/data
    networks: [openmapx]

  openconditions-archive:
    image: caddy:2-alpine
    restart: unless-stopped
    command: caddy file-server --root /data/archive --listen :8080
    volumes:
      - openmapx-openconditions-ingest-data:/data:ro
    networks: [openmapx]

networks:
  openmapx:
    external: true

volumes:
  openmapx-openconditions-ingest-data:
    external: true
  openconditions-federation-data:
```

and the public reverse proxy routes the paths, for example with Caddy:

```text
maps.example.org {
	handle /.well-known/openconditions/* {
		reverse_proxy openconditions-federation:4300
	}
	handle /peer/* {
		reverse_proxy openconditions-federation:4300 {
			flush_interval -1
		}
	}
	handle_path /archive/* {
		reverse_proxy openconditions-archive:8080
	}
}
```

Use the network and volume names of the install (`docker network ls`,
`docker volume ls`), and set the same `OPENCONDITIONS_INSTANCE_ID` on the
ingest and contributions services. Its signing keys live in the database; its
volume holds the registry's verified metadata and a peer's archive files while
they land, up to 32 GiB a file.
