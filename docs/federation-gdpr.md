# Federation, tombstones, and GDPR — an honest framing

This page states plainly what OpenConditions' federation deletion machinery
(lifetimes, signed tombstones, recipient notification) does and — just as
importantly — what it does **not** do under data-protection law. It is written so
an operator does not mistake a technical measure for a legal guarantee.

## What the machinery is

- **A lifetime (`freshness.expiresAt`) is data _minimisation_.** A crowd report
  lives as long as its evidence keeps it alive; once it expires, the sweep
  tombstones the record `expired`, which propagates as a federation delete, and
  purges it with its history after the history window
  (`OPENCONDITIONS_HISTORY_DAYS`). Minimisation reduces how long and how widely
  data is exposed. It is a good-practice control under the storage-limitation
  and data-minimisation principles.
- **A tombstone is a signed, reasoned retraction _event_.** A deletion is not a
  silent row removal but a new revision of the record carrying a tombstone
  reason (`expired`, `withdrawn`, `superseded`, `cancelled`, `rights_revoked`,
  `rejected`), journalled as a `delete` entry of the outbox and applied on a
  recipient's inbox. Because it is RFC 9421-signed like every federated message,
  an erasure carries a durable audit proof.
- **A tombstone is applied only against a copy the sending peer owns.** A peer
  sends only its own records, and its retraction tombstones only a local copy
  that peer wrote; it can never erase another instance's record or a locally
  originated one. This prevents a peer from weaponising "deletion" to censor
  data it did not produce.

## What the machinery is _not_

- **A lifetime is not a legal window.** An `expiresAt` value is an operational
  retention choice, not a statutory deadline. Do not describe a lifetime as
  "the legal window" — expiry does not, by itself, discharge any access,
  rectification, or erasure obligation, and a request can arrive for data that
  has already expired (it may persist in backups, logs, or a peer's store).
- **A tombstone is not a guaranteed erasure.** Propagation and recipient
  notification are **best-effort technical measures**. A peer may be offline,
  may have further re-shared the data, or may retain it under its own lawful
  basis. "We sent a tombstone" is evidence of a good-faith technical step, not
  proof that every copy is gone.
- **The provenance/origin chain routes a request; it does not decide the legal
  role.** The `provenance` and its `originChain` tell you _where a record came
  from_ so an erasure request can be forwarded to the right upstream. They do
  **not** determine who is the data controller versus processor for a given
  record — that is a legal allocation, not a routing fact. In particular, do not
  promise "origin-only controllership": the originating instance is not
  automatically the sole controller, and a downstream mirror is not automatically
  a mere processor.

## Erasure: the fact and the journal

The erasure reason is `rights_revoked`. Two concrete mechanisms back the
"an erased record can't come back" property:

- **An erasure fact.** Erasing a record records its canonical id in
  `conditions.federation_tombstone` for 30 days, here (`eraseRecord`) and on a
  recipient that applies the peer's `rights_revoked` delete. While the fact is
  live, the inbox admits no delivery of that canonical id — including one that
  arrives _after_ the erasure through a late page or a backfill. The fact is the
  deletion record, never the erased content.
- **A journal removal.** The `federation_outbox` journal is otherwise
  append-only, but a `rights_revoked` tombstone removes the record's earlier
  create and update entries, so a peer replaying an old cursor can no longer
  read the erased content. Only the `delete` entry remains, so the erasure itself
  still propagates. This targeted removal is a deliberate, narrowly-scoped
  exception to the append-only rule — justified precisely because an erasure
  request is the one case the rule must yield to.

The record's own revisions keep its content until the history window purges
the tombstoned record; an operator who must remove it sooner purges it by hand.

## Where the legal roles actually live

Controller/processor allocation, notice obligations, retention terms, and
incident handling between two federating instances are fixed by a **bilateral
agreement** (an MoU / Data Processing Agreement) that the operators review and
sign — not by a hard-coded constant in this codebase. That agreement, not the
software, is what allocates responsibility and sets any binding timelines. The
tombstone / lifetime / journal-removal mechanisms described above are the
_technical_ measures only; they do not, and cannot, allocate the legal roles.

## Operator checklist

1. Keep lifetimes short to minimise exposure, but never treat expiry as
   fulfilling a rights request.
2. On a verified erasure request, call `eraseRecord` (contributions-api) so the
   record is tombstoned `rights_revoked`, its journal entries are removed, its
   erasure fact is recorded, and a signed retraction propagates to peers.
3. Track the request and its propagation out-of-band; a sent tombstone is a step,
   not a closure.
4. Ensure a signed MoU/DPA with each peer defines controller/processor roles,
   notice windows, and retention — do not rely on the provenance chain to imply
   them.
