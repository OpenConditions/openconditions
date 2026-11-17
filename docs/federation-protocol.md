# Federation wire protocol

This document specifies how two OpenConditions instances exchange records, at the level a second, independent implementation needs. It describes protocol version **0.2**, which `packages/federation` exports as `FEDERATION_PROTOCOL_VERSION`. The operator side (configuration, pinning, the registry, deployment) is in the [federation onboarding guide](./federation-onboarding.md).

The key words MUST and MUST NOT are used as in RFC 2119 and RFC 8174, and only where an implementation that does otherwise would not interoperate or would weaken the trust model. Everything else describes what the reference implementation (`services/federation`, `packages/federation` and `services/contributions-api/src/federation/inbox.ts`) does. The values in the [test vectors](#11-test-vectors) are checked against that implementation by `packages/federation/src/__tests__/protocol-vectors.test.ts`; where this document and a vector disagree, the vector is right and this document has a bug.

## 1. Scope and status

The protocol replicates records (situations, features, offers and observations of the OpenConditions model) from the instance that wrote them, the publisher, to the instances that subscribe to it, operator to operator. Each instance publishes only its own records; a receiver refuses a record another instance wrote. It is not ActivityPub: some field names (`OrderedCollectionPage`, `orderedItems`, `partOf`, the actor's `type`, `outbox`, `inbox`) are borrowed from ActivityStreams, but the documents carry no `@context`, use their own types and are plain JSON, served and sent as `application/json`.

Federation has no production deployment yet and no peers, so version 0.2 makes no promise of compatibility with earlier drafts.

## 2. Discovery

Every instance has a base URL (`baseUrl`, the public origin peers reach it at). Two documents are served without authentication:

| Path                                     | Content                                 |
| ---------------------------------------- | --------------------------------------- |
| `/.well-known/openconditions/actor.json` | the actor document (`application/json`) |
| `/.well-known/openconditions/peers.json` | the peers document (`application/json`) |

Neither document is signed. A peer trusts an actor document only through the keys it pinned for that instance (§3).

### The actor document

| Field                   | Type             | Meaning                                                                                                                     |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | string           | `<baseUrl>/.well-known/openconditions/actor.json`. A peer's pin names this URL; a document with another `id` fails the pin. |
| `type`                  | array            | Always `["Service", "MobilityCommonsInstance"]`.                                                                            |
| `operator`              | string           | Who runs the instance.                                                                                                      |
| `jurisdiction`          | string           | Where the operator is established.                                                                                          |
| `transparencyReportUrl` | string, optional | An http(s) URL.                                                                                                             |
| `publicKey`             | array            | Every instance key valid now (see below). Never empty.                                                                      |
| `outbox`                | string           | `<baseUrl>/peer/outbox`                                                                                                     |
| `inbox`                 | string           | `<baseUrl>/peer/inbox`                                                                                                      |
| `subscriptions`         | string           | `<baseUrl>/peer/subscriptions`                                                                                              |
| `backfill`              | string           | `<baseUrl>/peer/backfill`                                                                                                   |
| `stream`                | string           | `<baseUrl>/peer/stream`                                                                                                     |
| `coverage`              | object           | `iso3166` (array of strings) and/or `bbox` (`[west, south, east, north]`).                                                  |
| `capabilities`          | object           | See below.                                                                                                                  |
| `license`               | string           | The licence the operator states for what it publishes.                                                                      |
| `policyDocument`        | string, optional | An http(s) URL.                                                                                                             |
| `trustTier`             | 0, 1 or 2        | The tier the operator states for itself. A receiver uses the tier it pinned, never this one.                                |
| `trustAnchor`           | array of strings | publicKeyMultibase values of governance anchor keys; empty when none are configured.                                        |

Each `publicKey` entry:

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `<actor id>#<publicKeyMultibase>`                                                                                                                                                                                                                                                                                                            |
| `owner`              | the actor `id`                                                                                                                                                                                                                                                                                                                               |
| `type`               | `"Multikey"`                                                                                                                                                                                                                                                                                                                                 |
| `publicKeyMultibase` | `z` (multibase base58btc) followed by the base58btc encoding of the multicodec `ed25519-pub` prefix `0xed 0x01` and the 32-byte raw Ed25519 public key; every value starts with `z6Mk`. This string is also the key's id in signatures (`keyid`). See [`multibase.json`](../packages/federation/src/__tests__/vectors/multibase.json).       |
| `endorsement`        | Absent on an instance's first key. Otherwise `{ by, signature, proof }`: `by` is the publicKeyMultibase of the previous key, `signature` that key's Ed25519 signature and `proof` this key's own Ed25519 signature, both base64url, over the UTF-8 bytes of `openconditions-federation key endorsement\n<instanceId>\n<publicKeyMultibase>`. |

Key rotation: a key is valid for six months. When the newest key has less than 30 days left, the instance creates the next one, endorsed by the newest. The actor document serves every key valid now, so both are served during the overlap. A new key signs only once it has been served for 7 days; until then the older key signs. A receiver trusts a served key that is pinned, or endorsed (with both signatures valid) by a key it already trusts, following the chain as far as the document goes, and keeps the keys it learned this way. A learned key is trusted only while the pin it leads back to is configured.

`capabilities`:

| Field                 | Meaning                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion`     | The protocol version the instance speaks, for this document `"0.2"`.                                                                                       |
| `protocolVersions`    | Optional: every version it still speaks.                                                                                                                   |
| `schemaVersions`      | Every schema its model registry runs, as `<key>@<major>.<minor>` (`kernel@1.0`, `situation/incident@1.2`). Taken from the registry, never configured.      |
| `wireFormats`         | The media types its documents are served in: `["application/json"]`. Taken from the running build, never configured.                                       |
| `deliveryModes`       | The delivery modes its subscriptions accept (§7): `["pull", "webhook", "sse"]`. Taken from the running build, never configured.                            |
| `subscriptionFilters` | The filter keys its subscriptions and journal reads accept (§6, §7); a filter with another key is refused. Taken from the running build, never configured. |
| `convergenceBound`    | Seconds. The instance warns its operator when its journal holds entries back longer than this (§5).                                                        |

A peer's rate budget is that of the tier its receiver pinned it at (§3), and whether it must use mutual TLS is the receiving operator's per-peer setting (§4); neither is advertised.

Negotiation: a receiver fetches the actor document at boot and hourly, checks it against its pin, and negotiates. The protocol version agreed is the highest version present in both sides' sets (`protocolVersion` plus `protocolVersions`), comparing dot-separated segments numerically where both are numbers. Two instances with no common version, no common wire format, or whose `kernel` schemas differ in major, cannot federate: the receiver does not store what such a document advertises, and as long as it has never stored a peer's schema versions it answers that peer's pushes with `503` (§8) and does not pull from it. The schemas the two exchange are those both advertise at the same major. A subscriber does not ask a peer for a delivery mode the peer's document, as verified this round, does not advertise; the reference subscriber reports that subscription as not kept instead.

### The peers document

`{ "peers": [ … ] }`, one entry per peer the instance trusts: `instanceId`, `actorUrl`, `trustTier`, `pinnedKeys` (its pins and the keys learned from them), and, when set, `coverage`, `mtlsRequired` and `mtlsFingerprints`. What the instance subscribes to or pulls at a peer is not served.

## 3. Trust

Trust between instances is a bilateral pin: each operator configures the other's `instanceId`, `actorUrl`, `trustTier` and at least one publicKeyMultibase (`pinnedKeys`), exchanged out of band. A request or response is attributed to a peer only when it is signed (§4) under a key trusted for that peer. A key is pinned for at most one peer.

The tier is the receiving operator's, from its pin; nothing a peer sends changes it. It decides how far back the journal is served live and the peer's rate budget:

| Tier | Meaning    | Journal served live                                     | Inbox entries per minute | Journal reads per minute |
| ---- | ---------- | ------------------------------------------------------- | ------------------------ | ------------------------ |
| 0    | public     | the last 24 hours                                       | 100                      | 100                      |
| 1    | peered     | the last 30 days                                        | 1000                     | 300                      |
| 2    | governance | at least 30 days (the reference service serves 30 days) | 2000                     | 600                      |

Journal reads are requests to `/peer/outbox` and `/peer/backfill` together. An unsigned request to `/peer/outbox` is served, and rate limited, as tier 0 (§9). Instances can also be discovered through a TUF-signed registry, whose entries become pins; see the onboarding guide, §2 and §5.

## 4. Message signing

Every request to an authenticated route, every page a peer pulls and every pushed page is signed with [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures using Ed25519.

### Parameters

A signature carries exactly these parameters, in this order: `created`, `expires`, `keyid`, `nonce`, `tag`.

| Parameter | Value                                                                  |
| --------- | ---------------------------------------------------------------------- |
| `created` | Unix seconds.                                                          |
| `expires` | `created` + 60.                                                        |
| `keyid`   | The signing key's publicKeyMultibase.                                  |
| `nonce`   | A fresh value per signature (the reference signer uses a random UUID). |
| `tag`     | `openconditions-federation`                                            |

The reference signer labels its signature `oc`. A verifier MUST NOT rely on the label: it MUST find the signatures whose `tag` is `openconditions-federation`, and refuse the message unless there is exactly one (none: `tag-mismatch`; more than one: `ambiguous-signature`). It then verifies only that one.

### Covered components

| Message  | Components, in the order the reference signer lists them                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request  | `"@method"`, `"@target-uri"`, then `"content-type"` (when there is a body and the header is present) and `"content-digest"` (when there is a body).                                                                |
| Response | `"@status"`, `"@method";req`, `"@target-uri";req`, `"signature";req` (only when the request carried a `Signature` field), then `"content-type"` and `"content-digest"` as for a request, then `"etag"` on a `304`. |

The request-bound components (`;req`, RFC 9421 section 2.4) tie a response to the request it answers: its method, its full target URI (and so the cursor and filter in its query) and, for a signed request, the request's whole `Signature` field, which carries the request's own nonce. A response that verifies as the answer to one request does not verify as the answer to another.

A verifier refuses with `insufficient-coverage`:

- a request that does not cover `@method`, and either `@target-uri` or all three of `@authority`, `@path` and `@query`;
- a response that does not cover `@status`, `@method;req` and `@target-uri;req`, or that does not cover `signature;req` when the request that was sent carried a `Signature` field.

A component with parameters does not stand in for the same component without them: `"@method";req` does not count as `"@method"`. A message with a body whose signature does not cover `content-digest` is refused with `bad-digest`.

### Target URI

The `@target-uri` a request is signed and verified with is the receiver's configured `baseUrl` followed by the path and query of the request, never the `Host` the request arrived with, so proxies may rewrite the host but not the path or query. A client builds the URL of a peer's route from the peer's pinned `actorUrl`: the URL with `/.well-known/openconditions/actor.json` removed from its end (or, when it does not end so, its origin), followed by the route's path. A webhook's `inboxUrl` MUST therefore be the subscriber's `<baseUrl>/peer/inbox`, since that is what the subscriber verifies the push against.

### Time and replay

A verifier refuses with `expired` a signature without `created` or `expires`, one whose `created` is more than 30 seconds after the verifier's clock, or one whose `expires` is more than 30 seconds before it. A signature without `nonce` is refused with `missing-nonce`. A verifier keeps each nonce it accepted, per `keyid`, for 90 seconds (the 60-second lifetime plus the 30-second skew) and refuses a nonce it already holds with `replayed`. The nonce is claimed only once the signature verified, so a forged message cannot use up a genuine nonce.

### Content-Digest

A body is bound by an [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530) `Content-Digest` field, covered by the signature. The reference signer sends one `sha-256` member. A verifier checks the field against the bytes it received, before parsing them: every `sha-256` and `sha-512` member present MUST match, at least one of them MUST be present, and other algorithms are ignored (they alone never satisfy the check). A `Content-Digest` is checked whenever it is present, an empty body included, so stripping a signed body is detected. A body without a `Content-Digest` is refused with `bad-digest`. See [`content-digest.json`](../packages/federation/src/__tests__/vectors/content-digest.json).

### What is signed

| Message                                                                                                                              | Signed                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Requests to `/peer/backfill`, `/peer/subscriptions[/<id>]`, `/peer/stream`, `/peer/inbox`                                            | yes, required                |
| Requests to `/peer/outbox`                                                                                                           | optional; unsigned is tier 0 |
| `200` and `304` answers of `/peer/outbox`, `200` answers of `/peer/backfill`                                                         | yes                          |
| Webhook pushes (`POST` to the subscriber's inbox)                                                                                    | yes                          |
| The actor and peers documents, subscription answers, inbox answers, the event stream, error answers, `/status` and `/status/journal` | no                           |

### Failures

A request that fails verification is answered `401` with a JSON body `{ "error": "federation request authentication failed", "reason": <reason> }` and the reason in the `Federation-Reason` header. A request to `/peer/outbox` that carries a `Signature` or `Signature-Input` header is verified like any other: an invalid signature is a `401`, never a silent fall back to tier 0.

| Reason                  | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `bad-digest`            | the `Content-Digest` is missing, does not match the body, or is not covered |
| `bad-signature`         | no or unparseable signature fields, or the signature does not verify        |
| `tag-mismatch`          | no signature tagged `openconditions-federation`                             |
| `ambiguous-signature`   | more than one signature tagged `openconditions-federation`                  |
| `expired`               | `created`/`expires` missing or outside the window                           |
| `missing-nonce`         | no `nonce`                                                                  |
| `unknown-key`           | no `keyid`, or one not trusted for any peer                                 |
| `insufficient-coverage` | the covered components are not enough (above)                               |
| `replayed`              | the nonce was used before                                                   |

A client verifies a signed response the same way, against the key it trusts for the peer and the request it sent; the reference puller refuses a page that does not verify and counts it against the peer's health.

### Mutual TLS

Mutual TLS is optional and never replaces the signature. When the receiving operator marks a peer `mtlsRequired`, a request from that peer must also arrive with a client certificate the TLS layer verified (and, when the operator pinned `mtlsFingerprints`, one of those). It is checked after the signature; a failure is answered `403` with `Federation-Reason: mtls-required` or `mtls-fingerprint-mismatch`.

## 5. The journal

Each instance keeps a journal of changes to its own records. Each entry has a cursor `(txid, seq)`: `txid` is the 64-bit id of the Postgres transaction that wrote it, `seq` a per-entry sequence number. Entries are ordered by `txid`, then `seq`, both as numbers. On the wire a cursor is `"<txid>.<seq>"`, both non-negative decimal integers without leading zeros (`0` itself is written `0`), `txid` at most 2^64 − 1 and `seq` at most 2^53 − 1; `"0.0"` is the start. Each position has exactly this one spelling: any other, such as `"01.2"` or `"1.02"`, is refused as malformed. A transaction that took a higher `seq` can have the lower `txid`, so `"1000.14"` comes before `"1001.11"`. See [`cursors.json`](../packages/federation/src/__tests__/vectors/cursors.json).

A page serves only settled entries: an entry is served only once no transaction that could still add an entry ordered before it is open, so a page never contains an entry that an entry published later could precede, and a cursor never has to move back. While a write transaction stays open anywhere on the publisher's database server, entries committed after it began wait. The publisher logs a warning while that lasts longer than its `convergenceBound`, and `GET /status/journal` answers `{ "epoch", "heldSince", "lagSec" }`: when the oldest entry still held back was journalled (null when none is) and how many seconds ago.

Every page has a `highWaterMark`: the cursor of the last entry the publisher read for the page, whether or not the subscriber's filter kept it, or the requested cursor when nothing new is settled. A subscriber stores it and sends it as `after` next time.

### Epochs

Transaction ids only order entries within one history of the database. The publisher names the current history with its journal's `epoch` (a UUID in the reference implementation; to a subscriber an opaque string of 1 to 64 characters), and every page states it. The publisher starts a new epoch when its database went back (transaction ids lower than before, the Postgres timeline changed, or its operator asked for it after restoring an older copy). It then empties its journal of everything but the delete entries, sets every subscription's push cursor back to `"0.0"` and journals its current records again for the subscriptions that exist. The delete entries are carried into the new epoch with new cursors, in their old order and with the `createdAt` they had, so a retraction or an erasure a subscriber had not read yet still reaches it, within its tier's window, ahead of the records journalled again.

A page whose request named a cursor the journal has not reached carries `cursorAhead: true`, no entries, and the requested cursor as its `highWaterMark`. A cursor a publisher handed out always lies below the oldest transaction still running at the time, and that never goes back within one history, so such a cursor belongs to a history the database no longer has.

A subscriber MUST keep the epoch with its cursor and:

- with no epoch stored yet, store the page's;
- when a page names another epoch than the one stored, or says `cursorAhead`, not land the page, set its cursor back to `"0.0"`, store the page's epoch and read the journal again from the start; what it already holds lands as stale (§6);
- treat `cursorAhead` on a request from `"0.0"` as the publisher's error;
- when its cursor is `"0.0"` and only the epoch differs, store the page's epoch and land the page.

The reference puller follows at most one such restart per pull and none within an hour of the last; another is refused and counted against the peer's health, the cursor left where it is. A page without an `epoch`, or with one that is not a string of 1 to 64 characters, is refused. Pushed pages carry the epoch too, but the push cursor lives at the publisher, so the inbox does not act on it; a push cursor that is ahead of the journal is set back to `"0.0"` by the publisher. The cursor of the event stream lives at the subscriber, and the stream's first event states the epoch and whether the cursor asked for is ahead (§8): a stream subscriber keeps the epoch with its cursor by the same rules, and on another epoch reconnects without a cursor.

### Retention

Entries older than 37 days (the widest live window, 30 days, plus 7 days) are deleted daily. History before a peer's window is served by the static archive (§6).

## 6. Reading the journal

### Routes

| Route                | Authentication              | Serves                                                                                           |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /peer/outbox`   | optional (unsigned: tier 0) | the journal after `after`, within the requester's tier window; ETag and `304`; rate limited (§9) |
| `GET /peer/backfill` | required                    | the same page within the pinned tier's window; rate limited (§9); no ETag                        |

The reference puller reads `/peer/backfill` while catching up (from `"0.0"`, or after a page that had a `next`) and `/peer/outbox` once it reached the live tail.

### Query parameters

| Parameter                                          | Value                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `after`                                            | a cursor; default `"0.0"`                                                                                                      |
| `limit`                                            | entries read per page, at least 1; default 100, at most 500 (a larger value is lowered to 500)                                 |
| `bbox`                                             | `west,south,east,north`, four numbers                                                                                          |
| `classes`                                          | comma-separated record classes: `feature`, `situation`, `observation`, `offer`                                                 |
| `kinds`, `domains`, `properties`, `privacyClasses` | comma-separated values                                                                                                         |
| `minEvidenceTier`                                  | `self_reported`, `corroborated` or `externally_resolved`; crowd records weaker than this are left out (default `corroborated`) |
| `maxAgeSec`                                        | a non-negative integer: records last stated longer ago are left out                                                            |
| `sourceLiveness`                                   | `true` or `false`: whether to serve liveness entries (default `false`)                                                         |

A malformed parameter, or one not in this table, is answered `400` with `{ "error" }` naming it: a filter the publisher does not know is refused rather than ignored, so a subscriber is never sent more than it asked for. The filter parameters are exactly the keys the actor document advertises as `subscriptionFilters`. The filter is applied at the publisher: an entry it leaves out still moves the `highWaterMark`. A delete entry always passes the filter. With `kinds` or `properties`, a record whose kind (or, for an observation, property) is not named is left out. Only records whose licence permits redistribution leave the publisher, whatever the filter asks.

### The page

| Field                | Meaning                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type`               | `"OrderedCollectionPage"`                                                                                                            |
| `partOf`             | `<baseUrl>/peer/outbox` or `<baseUrl>/peer/backfill`                                                                                 |
| `highWaterMark`      | a cursor (§5)                                                                                                                        |
| `epoch`              | the journal's epoch (§5)                                                                                                             |
| `orderedItems`       | the entries the filter kept, in cursor order                                                                                         |
| `next`               | present when the page read `limit` entries: `<partOf>?after=<highWaterMark>` followed by the request's filter and `limit` parameters |
| `cursorAhead`        | `true` when the requested cursor is ahead of the journal (§5)                                                                        |
| `beyondWindow`       | `true` when entries after the cursor lie before the requester's window                                                               |
| `archive`            | with `beyondWindow`, when the publisher has one: the static archive (below)                                                          |
| `priorityRestricted` | only on pushed pages (§8)                                                                                                            |

`archive` is `{ "builtAt": <ISO 8601>, "files": { "feature", "situation", "offer", "observation": { "url", "sha256", "bytes" } } }`: the latest nightly GeoParquet file of each class, its SHA-256 (64 lowercase hex digits) and size. The files may be served from anywhere; a receiver MUST check each against the hash and size the signed page states before landing it, and lands them in that class order before the page. When an archive exists, the window reaches back to when its night's build began, but at most 36 hours before the tier's floor, so nothing falls between the archive and the live journal. See [archive.md](./archive.md).

The ETag of an outbox page is `"<highWaterMark>-<hash>"`, the hash covering the epoch, the requested cursor, the limit, the filter, the requester's tier and the archive's `builtAt`. A request whose `If-None-Match` equals it is answered `304` without a body, signed and covering `etag`.

An example page is [`page.json`](../packages/federation/src/__tests__/vectors/page.json).

### Entries

Every entry has `seq` (a number), `txid` (a decimal string), `operation` and `createdAt` (when it was journalled, ISO 8601).

| `operation`        | Further fields                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`, `update` | `recordClass`, `recordId`, `canonicalId` (string or null), `kind`, `domain`, `property` (observations), `record`: the record as the publisher stored it, the reporter of a crowd report removed                                     |
| `delete`           | the same identifying fields, `tombstone: true`, `reason` (`expired`, `withdrawn`, `superseded`, `cancelled`, `rights_revoked` or `rejected`) and `revision`, the revision the record ended at (an erasure may lack it); no `record` |
| `liveness`         | `sourceId`, `domain`, `polledAt` (ISO 8601), `cadenceSec` (optional): the publisher polled the source successfully then, so its unchanged readings still hold. Served only to a subscriber that asks for it (`sourceLiveness`).     |

A crowd report the crowd withdrew is served as a `delete` (`withdrawn`, or `expired`).

### Receiving

A receiver reads each entry and refuses one that is malformed, without refusing the rest of the page:

- a change MUST carry its `record`, a delete MUST NOT;
- a delete MUST carry a `revision` (an integer of at least 1), except an erasure (`rights_revoked`); a `reason` outside the list above is read as `withdrawn`;
- a liveness entry MUST name its source and a parseable `polledAt`; a `cadenceSec` outside 1 second to 7 days is ignored;
- `recordClass` MUST be one of the four classes, `txid` a string and `seq` a number.

[`entries.json`](../packages/federation/src/__tests__/vectors/entries.json) lists entries the reference reader accepts, as what, and entries it refuses, with the reason.

A record is admitted only if its `provenance.instanceId` is the peer it came from (peers send only their own records), it is not an on-demand answer or a fused row, and both instances run its schemas at the same major. A record of a schema the receiver does not run, or runs at another major, is skipped. When the peer advertises a newer minor of a schema the record uses, fields the receiver does not know are dropped; otherwise a record that fails validation is refused. The receiver removes any reporter and adds its receipt to the record's origin chain.

Landing: a change no newer than the copy held lands as `stale` and changes nothing, so a page that arrives by push and by pull lands once. A record held under the same id from another instance is not overwritten. A delete applies only to a copy the peer owns, and is `stale` when the copy changed to a later revision since. An erasure (`rights_revoked`) ends every revision, and the receiver refuses further deliveries of that record (by `canonicalId`) from that peer for 30 days. A local failure rejects the whole page, so the publisher or puller retries it.

The reference puller also requires of each page that it carries at most 100 entries and 1 MiB, arrives within 60 seconds, carries a valid `highWaterMark` not before the cursor asked for, and that every entry lies after that cursor and at or before the `highWaterMark`; it advances its cursor to the `highWaterMark` only once the page landed, reads at most 20 pages per pull, and pulls every 30 seconds.

## 7. Subscriptions

A publisher journals only what some subscription wants, so a subscriber that pulls also keeps a `pull` subscription. All routes require a signature; the subscriber is the peer the signature names, and it sees and changes only its own subscriptions.

| Route                             | Body                       | Success                                               |
| --------------------------------- | -------------------------- | ----------------------------------------------------- |
| `POST /peer/subscriptions`        | the subscription to create | `201` with the subscription                           |
| `GET /peer/subscriptions`         |                            | `200` with `{ "subscriptions": [ … ] }`, newest first |
| `GET /peer/subscriptions/<id>`    |                            | `200` with the subscription                           |
| `PATCH /peer/subscriptions/<id>`  | the fields to change       | `200` with the subscription                           |
| `DELETE /peer/subscriptions/<id>` |                            | `204`                                                 |

Request fields: `filter` (the filter of §6 as an object; default `{}`), `deliveryMode` (`pull`, `webhook` or `sse`; default `pull`), `inboxUrl` (for a webhook), `priorityOnly` (default `true`). A subscription in an answer has `id`, `peerId`, `filter`, `deliveryMode`, `inboxUrl`, `cursor` (its push cursor), `priorityOnly`, `pushFailures`, `revision`, `status` (`active` or `push_disabled`), `createdAt`, `updatedAt` and `expiresAt`.

Validation (`422` with `{ "error", "code" }`):

| `code`                  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-delivery-mode` | `deliveryMode` is not one of the three                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `invalid-filter`        | the filter is not an object; it has a key that is not one of `subscriptionFilters` (the message names it); `bbox` is not four finite numbers with west < east and south < north within ±180/±90; an allow-list is not a non-empty array of non-empty strings; `classes` names an unknown class, or `observation` without `properties`; `minEvidenceTier` is not one of the three tiers; `maxAgeSec` is not a number greater than 0; `sourceLiveness` is not a boolean |
| `over-broad-filter`     | a `webhook` or `sse` subscription whose filter has none of `bbox`, `kinds`, `domains`, `properties`, `privacyClasses`, `maxAgeSec`; the answer adds `recommended`, the filter with `kinds: ["closure", "incident"]`                                                                                                                                                                                                                                                   |
| `inbox-required`        | a `webhook` without `inboxUrl`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `inbox-not-public`      | an `inboxUrl` that is not a valid https URL of a public address (an inbox on the subscriber's own host may be private and plain http where the publisher's operator allows that host)                                                                                                                                                                                                                                                                                 |

A peer holds at most one `pull` subscription and one `webhook` per inbox URL; a second is answered `409` with `{ "error", "existingId" }`, naming the one held, which the peer patches instead. `sse` subscriptions are not limited. Other answers: `400` for a body that is not a JSON object, `404` for a subscription that does not exist or whose lease ran out, `403` for one of another peer.

A `PATCH` merges the fields given with the stored ones and validates the result. It also sets `status` back to `active` and `pushFailures` to 0, which resumes a push the publisher disabled where it stalled.

Leases: a subscription lasts 30 days (`expiresAt`) and every accepted `PATCH` renews it for 30 days from then, a `PATCH` with an empty body included. A subscription whose lease ran out is not pushed, is answered `404` and is not listed, is deleted within the hour, and does not count against the one-per-target rule. The reference subscriber checks its subscriptions hourly: it creates a missing one, patches one that differs from what it wants or whose push was disabled, and patches a matching one when 15 days or less of its `expiresAt` remain, or when `expiresAt` is missing or unreadable.

## 8. Push

### Webhooks

For each active `webhook` subscription the publisher reads a page after the subscription's cursor (at most 100 entries in the reference implementation, every 5 seconds), within the subscriber's tier window, and `POST`s it, signed, to the `inboxUrl` as `application/json`. The page is the outbox page (§6) with `type`, `partOf` (the publisher's `<baseUrl>/peer/outbox`), `highWaterMark`, `epoch` and `orderedItems`, plus `priorityRestricted: true` when the subscription is `priorityOnly`. A `priorityOnly` subscription is pushed only priority entries (a situation that closes a road or all its lanes, or an incident) and every delete; its cursor moves over that subsequence only, so the push is not complete, and a subscriber that wants every entry pulls as well. A page with no entries is not sent; the cursor still moves over what the filter left out.

| Inbox answer                       | Publisher                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2xx`                              | moves the cursor to the page's `highWaterMark`, sets `pushFailures` to 0                                                                                           |
| `429`, or `503` with `Retry-After` | waits `Retry-After` seconds (60 when unreadable) and sends again; counts nothing                                                                                   |
| anything else, or no answer        | counts a failure and leaves the cursor; at 5 consecutive failures sets `status` to `push_disabled` and stops pushing until the subscriber patches the subscription |

The publisher pushes nothing to a peer it blocked or no longer trusts.

The inbox (`POST /peer/inbox`) requires a signature and answers:

| Status | When                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `200`  | the page was landed: `{ accepted, stale, tombstoned, liveness, skipped: [{ recordId?, reason }], maxCursor }`              |
| `400`  | the body is not JSON, or has no `orderedItems` array                                                                       |
| `401`  | the signature failed (§4)                                                                                                  |
| `403`  | the peer is blocked here, or fails mutual TLS                                                                              |
| `429`  | the peer is over its rate budget (§9)                                                                                      |
| `503`  | the receiver has not yet verified the peer's actor document (`Federation-Reason: capabilities-unknown`, `Retry-After: 60`) |

Entries refused inside an authenticated page are listed in `skipped`; they do not fail the page.

### The event stream

`GET /peer/stream?subscriptionId=<id>[&after=<cursor>]` (signed; `after` is part of the signed target URI) streams a subscription's entries as server-sent events (`text/event-stream`): `400` without `subscriptionId` or with a malformed cursor, `404` or `403` as for the subscription routes.

The subscriber holds the stream's cursor: server-sent events have no acknowledgement, so the publisher cannot know what arrived and stores nothing of how far a stream got. The stream starts after `after`; without it, after the cursor in a `Last-Event-ID` request header (what an EventSource client sends when it reconnects; every entry event's `id` is its cursor); without either, at the subscription's stored cursor. The `Last-Event-ID` header is not covered by the request signature: like the stream's events, it rests on the transport (TLS), so a client that can set `after` should prefer it. The first event of every stream is

```text
event: journal
data: {"epoch":"<epoch>","cursor":"<cursor>"}
```

with the journal's epoch and the cursor the stream starts after. A client compares that cursor with the one it sent; they differ only with `cursorAhead`. When the cursor asked for is ahead of the journal (§5), the event adds `"cursorAhead":true`, `cursor` is `"0.0"` and the stream starts from the beginning. Each entry is then one event:

```text
event: record
id: <cursor>
data: {"cursor":"<cursor>","entry":{…}}
```

with `event: liveness` for a liveness entry. The stream applies the subscription's filter, `priorityOnly` and the peer's tier window, reads every 3 seconds (at most 500 entries at a time), and writes a comment line `: ping <cursor>` every 3 seconds unless the connection is backed up.

## 9. Limits and errors

| Limit                                  | Value                                                |
| -------------------------------------- | ---------------------------------------------------- |
| Page size (`limit`)                    | default 100, at most 500                             |
| Request body (inbox, subscriptions)    | 1 MiB (the server answers `413` above)               |
| Page a puller accepts                  | 100 entries, 1 MiB, 60 seconds                       |
| Signature lifetime, skew, nonce memory | 60 s, ±30 s, 90 s                                    |
| Epoch length                           | 1 to 64 characters                                   |
| Subscription lease, renewal            | 30 days, renewed by the subscriber with 15 days left |

Rate limits are per peer and per minute, in fixed one-minute windows, with the budgets of §3: the inbox counts entries, journal reads count requests, a signed peer's `/peer/outbox` and `/peer/backfill` requests drawing on one budget. Unsigned `/peer/outbox` requests are metered per client address with tier 0's budget, an IPv6 address by its /64 prefix and an IPv4-mapped IPv6 address as the IPv4 address. The check comes after authentication and before the journal is read, so a `304` counts too. A window that has seen nothing yet admits one page of up to 500 entries whatever the budget, and refuses a larger one. Over the budget a request is answered `429` with `Retry-After`, `Federation-Reason: rate-limited` and a JSON body `{ "error", "retryAfterSec" }`. A peer over its budget in 3 consecutive windows gets the budget of the tier below for 5 minutes; this changes only its rate, never what was already accepted from it.

A peer the operator blocked is answered `403` with `{ "error": "peer is blocked", "reason": "blocked" }` on every authenticated route, and on `/peer/outbox` when the request is signed. A route of a federation that is not enabled answers `404`.

## 10. Versioning

The protocol version is negotiated through `capabilities.protocolVersion` and `protocolVersions` (§2). The reference service warns its operator at boot when the configured actor does not offer `0.2`, but starts all the same.

Record schemas are versioned separately, `<key>@<major>.<minor>`, and negotiated per schema (§2, §6): the same major is compatible, a newer minor's unknown fields are dropped, another major is not exchanged, and instances on different `kernel` majors exchange nothing.

A receiver ignores fields of a page or an entry it does not know: the reference puller and inbox read only the fields this document names. Unknown fields inside a `record` are handled by the schema rules above, not ignored.

## 11. Test vectors

The vectors are JSON files in [`packages/federation/src/__tests__/vectors/`](../packages/federation/src/__tests__/vectors/), checked against the implementation by `protocol-vectors.test.ts` in the same package.

| File                  | Content                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signing.json`        | A signed `GET` of the outbox and the signed page answering it, bound to it: the key (the RFC 9421 Appendix B.1.4 `test-key-ed25519`, a published test key), fixed `created`, `expires` and nonces, the signature bases and the exact header values. Ed25519 is deterministic, so an implementation reproduces the signatures byte for byte. |
| `content-digest.json` | `Content-Digest` values of given bodies.                                                                                                                                                                                                                                                                                                    |
| `multibase.json`      | The publicKeyMultibase of the test key.                                                                                                                                                                                                                                                                                                     |
| `cursors.json`        | Valid and invalid cursor wire forms and an ascending order.                                                                                                                                                                                                                                                                                 |
| `page.json`           | An example page with an epoch, a change of a record the reference registry admits, a retraction, an erasure and a liveness entry.                                                                                                                                                                                                           |
| `entries.json`        | Entries the reference reader accepts, as what, and entries it refuses, with the reason.                                                                                                                                                                                                                                                     |
