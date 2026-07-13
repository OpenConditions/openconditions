# Federation, tombstones, and GDPR — an honest framing

This page states plainly what OpenConditions' federation deletion machinery
(TTLs, signed tombstones, recipient notification) does and — just as
importantly — what it does **not** do under data-protection law. It is written so
an operator does not mistake a technical measure for a legal guarantee.

## What the machinery is

- **TTL (`expiresAt`) is data _minimisation_.** A short time-to-live means a
  record disappears from the published view once it expires, and the sweep then
  hard-deletes it (emitting an `expired` federation tombstone). Minimisation
  reduces how long and how widely data is exposed. It is a good-practice control
  under the storage-limitation and data-minimisation principles.
- **A tombstone is a signed, reasoned retraction _event_.** A deletion is not a
  silent row removal but a first-class event carrying a `tombstoneReason`
  (`deleted_by_source`, `gdpr_erasure`, `retracted_as_wrong`, `expired`,
  `legal_takedown`), propagated over the outbox with its own sequence and applied
  on a recipient's inbox under the same source-aware ownership rules as any other
  federated write. Because it is RFC 9421-signed like every federated message, an
  erasure carries a durable audit proof.
- **A tombstone is applied only against a row the sending peer owns.** A peer can
  retract a record it originated (its own instance) or a same-source feed record
  it independently ingested; it can never erase another instance's row or a
  locally-originated row. This prevents a peer from weaponising "deletion" to
  censor data it did not produce.

## What the machinery is _not_

- **TTL is not a legal window.** An `expiresAt` value is an operational retention
  choice, not a statutory deadline. Do not describe an arbitrary TTL (7 days, 30
  days, …) as "the legal window" — expiry does not, by itself, discharge any
  access, rectification, or erasure obligation, and a request can arrive for data
  that has already expired (it may persist in backups, logs, or a peer's store).
- **A tombstone is not a guaranteed erasure.** Propagation and recipient
  notification are **best-effort technical measures**. A peer may be offline,
  may have further re-shared the data, or may retain it under its own lawful
  basis. "We sent a tombstone" is evidence of a good-faith technical step, not
  proof that every copy is gone.
- **The provenance/origin chain routes a request; it does not decide the legal
  role.** The `origin` and `originChain` fields tell you _where a record came
  from_ so an erasure request can be forwarded to the right upstream. They do
  **not** determine who is the data controller versus processor for a given
  record — that is a legal allocation, not a routing fact. In particular, do not
  promise "origin-only controllership": the originating instance is not
  automatically the sole controller, and a downstream mirror is not automatically
  a mere processor.

## Terminal tombstones and the journal-scrub exception

Two concrete mechanisms back the "re-discovery can't resurrect" property:

- **A terminal deletion fact.** Tombstoning a record UPSERTs its `canonicalId`
  into `conditions.federation_tombstone` (`emitTombstone` /
  `applyFederatedTombstone`, migration `0019_federation_tombstone`). While that
  fact is live (30 days), the federated ingest refuses to create, reactivate, or
  rewrite the same canonicalId — including a create that arrives _after_ the
  tombstone (the create-after-tombstone race). After 30 days the fact lapses and
  a genuine re-discovery may resurrect the record; the fact is the deletion
  record, never the erased content.
- **A GDPR-erasure-only journal scrub.** The `federation_outbox` journal is
  otherwise append-only, but a `gdpr_erasure` or `legal_takedown` tombstone
  strips the free-text fields (`headline`, `description`, `subject`,
  `attributes`, `label`) from that object's prior create/update snapshots, so a
  peer replaying an old cursor can no longer read the erased content. This
  targeted rewrite is a deliberate, narrowly-scoped exception to the append-only
  rule — justified precisely because an erasure request is the one case the rule
  must yield to; id/canonicalId/type/geometry and the tombstone entry are kept.

## Where the legal roles actually live

Controller/processor allocation, notice obligations, retention terms, and
incident handling between two federating instances are fixed by a **bilateral
agreement** (an MoU / Data Processing Agreement) that the operators review and
sign — not by a hard-coded constant in this codebase. That agreement, not the
software, is what allocates responsibility and sets any binding timelines. The
tombstone / TTL / journal-scrub mechanisms described above are the _technical_
measures only; they do not, and cannot, allocate the legal roles.

## Operator checklist

1. Set TTLs to minimise exposure, but never treat expiry as fulfilling a rights
   request.
2. On a verified erasure request, call the `gdpr_erasure` tombstone path so the
   record is scrubbed locally (archived, content and reporter identity removed,
   the audit ledger retained) and a signed retraction propagates to peers.
3. Track the request and its propagation out-of-band; a sent tombstone is a step,
   not a closure.
4. Ensure a signed MoU/DPA with each peer defines controller/processor roles,
   notice windows, and retention — do not rely on the provenance chain to imply
   them.
