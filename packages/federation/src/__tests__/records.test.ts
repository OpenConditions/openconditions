import {
  buildRegistry,
  extendVocabulary,
  type FusableObservation,
  fuse,
  fusedObservation,
  landClaim,
  observationId,
  schemaVersions,
  sealRecord,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import {
  admitFederatedRecord,
  applyRecordFilter,
  type FederatedRecord,
  federatedSnapshot,
  type RecordOutboxEntry,
  readInboundEntry,
} from "../index.js";

const registry = buildRegistry([
  ...productionModules,
  {
    name: "records-test",
    entries: [extendVocabulary({ vocabulary: "source_format", values: ["ocpi"] })],
  },
]);
const PEER = "peer.example.net";
const NOW = "2026-10-01T12:00:00Z";
const KEY = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";

function sealed(draft: Record<string, unknown>, instanceId = PEER): FederatedRecord {
  const result = sealRecord(registry, draft, { instanceId, revision: 1, recordedAt: NOW });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value as unknown as FederatedRecord;
}

const point = { type: "Point", coordinates: [4.9, 52.37] };
const location = { geometry: point, extent: "point", geometryOrigin: "source", fuzziness: "exact" };

function feedClosure(license = "CC0-1.0") {
  return sealed({
    id: "oc:situation:nl-ndw:SIT-1",
    class: "situation",
    kind: "closure",
    type: "closure",
    temporality: "live",
    location,
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw",
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: "SIT-1",
      sourceUpdatedAt: "2026-10-01T11:00:00Z",
      attribution: { provider: "NDW", license },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: "2026-10-01T11:01:00Z" },
    extras: { situationRecordExtension: "x" },
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "declared", declaredRaw: "high" },
    validity: { status: "active", start: "2026-10-01T10:00:00Z" },
    effects: [],
    details: { kind: "closure", v: 1 },
  });
}

function crowdAccident(evidence?: string) {
  const landed = landClaim(
    registry,
    {
      claim: {
        claimClass: "situation",
        kind: "incident",
        type: "accident",
        geometry: point,
        fuzziness: "exact",
        reportedAt: "2026-10-01T11:58:00Z",
        nonce: "records-nonce-00000001",
      },
      keyId: KEY,
    },
    { instanceId: PEER, now: NOW, attribution: { provider: PEER, license: "CC0-1.0" } },
  );
  if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
  const record = sealed(landed.draft);
  return evidence === undefined
    ? record
    : ({
        ...record,
        evidence: {
          state: evidence,
          confidenceScore: 0.6,
          routingEligible: false,
          corroborations: 1,
        },
      } as FederatedRecord);
}

const entry = (record: FederatedRecord, seq: number): RecordOutboxEntry => ({
  seq,
  txid: "1000",
  operation: "create",
  recordClass: record.class,
  recordId: record.id,
  canonicalId: null,
  kind: record.kind,
  domain: record.domain,
  ...(record.property === undefined ? {} : { property: record.property }),
  createdAt: NOW,
  record,
});

describe("what the outbox carries", () => {
  it("strips the reporter, and the extras unless the source federates them", () => {
    const crowd = federatedSnapshot(crowdAccident(), { federateExtras: false })!;
    expect(crowd.provenance.reporter).toBeUndefined();
    expect(federatedSnapshot(feedClosure(), { federateExtras: false })!.extras).toBeUndefined();
    expect(federatedSnapshot(feedClosure(), { federateExtras: true })!.extras).toEqual({
      situationRecordExtension: "x",
    });
  });

  it("never carries an on-demand answer or a fused row", () => {
    const onDemand = {
      ...feedClosure(),
      provenance: { ...feedClosure().provenance, accessMode: "on_demand" },
    } as FederatedRecord;
    expect(federatedSnapshot(onDemand, { federateExtras: false })).toBeUndefined();
    const draft = {
      class: "observation",
      kind: "observation",
      property: "charging.evse_status",
      temporality: "live",
      location,
      provenance: {
        origin: "feed",
        sourceId: "de-bw-ocpdb",
        sourceFormat: "ocpi",
        accessMode: "bulk",
        recordId: "x",
        attribution: { provider: "MobiData BW", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: NOW },
      subject: { kind: "feature", featureId: "oc:feature:de-bw-ocpdb:1", componentKey: "1" },
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: "2026-10-01T11:00:00Z" },
      aggregation: "instantaneous",
    };
    const status = sealed({ id: observationId("de-bw-ocpdb", draft as never), ...draft });
    const fusion = fuse(
      registry,
      "charging.evse_status",
      [
        {
          observation: status as unknown as FusableObservation,
          sourceTier: "aggregator",
          stale: false,
        },
      ],
      NOW,
    )!;
    const fused = fusedObservation(registry, fusion, {
      subject: { kind: "feature", featureId: "oc:feature:local:c", componentKey: "1" },
      location: location as never,
      instanceId: "local",
      now: NOW,
    });
    expect(fused.ok).toBe(true);
    if (!fused.ok) return;
    const fusedRecord = sealed(fused.value, "local");
    expect(federatedSnapshot(fusedRecord, { federateExtras: false })).toBeUndefined();
  });
});

describe("the subscriber filter on records", () => {
  const entries = [
    entry(feedClosure(), 1),
    entry(crowdAccident("self_reported"), 2),
    entry(crowdAccident("corroborated"), 3),
  ];
  const ids = (filter: Parameters<typeof applyRecordFilter>[1]) =>
    applyRecordFilter(entries, filter, NOW).map((e) => e.seq);

  it("passes corroborated crowd records by default, and self-reported ones on request", () => {
    expect(ids(undefined)).toEqual([1, 3]);
    expect(ids({ minEvidenceTier: "self_reported" })).toEqual([1, 2, 3]);
  });

  it("filters by class, kind, domain and property, from the journal's columns", () => {
    expect(ids({ kinds: ["closure"] })).toEqual([1]);
    expect(ids({ classes: ["observation"] })).toEqual([]);
    expect(ids({ properties: ["charging.evse_status"] })).toEqual([]);
    expect(ids({ domains: ["roads"] })).toEqual([1, 3]);
    expect(ids({ domains: ["hazards"] })).toEqual([]);
  });

  it("drops share-alike records unless asked, and strips reporters either way", () => {
    const shareAlike = entry(feedClosure("CC-BY-SA-4.0"), 4);
    expect(applyRecordFilter([shareAlike], undefined, NOW)).toEqual([]);
    expect(applyRecordFilter([shareAlike], { permissiveOnly: false }, NOW)).toHaveLength(1);
    const withReporter = entry(crowdAccident("corroborated"), 5);
    const [out] = applyRecordFilter([withReporter], { permissiveOnly: false }, NOW);
    expect(out!.record!.provenance.reporter).toBeUndefined();
  });

  it("filters by age and box, and always passes a retraction", () => {
    expect(ids({ maxAgeSec: 1800 })).toEqual([3]);
    expect(ids({ bbox: [5, 52, 6, 53] })).toEqual([]);
    const retraction: RecordOutboxEntry = {
      ...entries[0]!,
      seq: 9,
      operation: "delete",
      record: undefined,
      tombstone: true,
      reason: "withdrawn",
    };
    expect(applyRecordFilter([retraction], { kinds: ["alert"] }, NOW)).toEqual([retraction]);
  });
});

describe("receiving a peer's record", () => {
  const peerVersions = schemaVersions(registry);
  const receipt = { peerInstanceId: PEER, peerVersions, receivedAt: NOW };

  it("keeps the record and adds the receipt to its origin chain", () => {
    const admitted = admitFederatedRecord(registry, receipt, feedClosure());
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(admitted.record["provenance"]).toMatchObject({
      instanceId: PEER,
      originChain: [{ instanceId: PEER, viaPeer: PEER, receivedAt: NOW }],
    });
  });

  it("never keeps a reporter's key, even when a peer sent one", () => {
    const admitted = admitFederatedRecord(registry, receipt, crowdAccident("corroborated"));
    expect(admitted.admitted && admitted.record["provenance"]).not.toHaveProperty("reporter");
  });

  it("refuses another instance's record, an on-demand answer, and a non-object", () => {
    expect(
      admitFederatedRecord(
        registry,
        { ...receipt, peerInstanceId: "other.example" },
        feedClosure(),
      ),
    ).toMatchObject({
      admitted: false,
      issues: [{ code: "relayed" }],
    });
    const onDemand = {
      ...feedClosure(),
      provenance: { ...feedClosure().provenance, accessMode: "on_demand" },
    };
    expect(admitFederatedRecord(registry, receipt, onDemand)).toMatchObject({
      admitted: false,
      issues: [{ code: "never_federated" }],
    });
    expect(admitFederatedRecord(registry, receipt, "x")).toMatchObject({ admitted: false });
  });

  it("skips a kind this instance does not run, and accepts a newer minor's extra fields", () => {
    const peerAhead = peerVersions.map((v) =>
      v.startsWith("situation/closure@") ? "situation/closure@1.4" : v,
    );
    const extended = {
      ...feedClosure(),
      details: { kind: "closure", v: 1, detourSigned: true },
    };
    const admitted = admitFederatedRecord(
      registry,
      { ...receipt, peerVersions: peerAhead },
      extended,
    );
    expect(admitted).toMatchObject({ admitted: true, stripped: ["details.detourSigned"] });
    expect(
      admitFederatedRecord(registry, receipt, { ...feedClosure(), kind: "volcano_eruption" }),
    ).toEqual({ admitted: false, skipped: "situation/volcano_eruption is not registered here" });
  });
});

describe("reading a peer's outbox entry", () => {
  const head = {
    seq: 7,
    txid: "812",
    recordClass: "situation",
    recordId: "oc:situation:nl-ndw:x",
    canonicalId: "c".repeat(64),
  };

  it("reads a change with its record and a retraction with its reason", () => {
    const record = feedClosure();
    expect(readInboundEntry({ ...head, operation: "update", record })).toEqual({
      ok: true,
      entry: { ...head, operation: "update", record },
    });
    expect(
      readInboundEntry({ ...head, operation: "delete", tombstone: true, reason: "withdrawn" }),
    ).toEqual({ ok: true, entry: { ...head, operation: "delete", reason: "withdrawn" } });
    expect(readInboundEntry({ ...head, operation: "delete", reason: "erased" })).toEqual({
      ok: true,
      entry: { ...head, operation: "delete", reason: "withdrawn" },
    });
  });

  it("refuses a retraction that carries a record, a change without one, and a malformed entry", () => {
    expect(readInboundEntry({ ...head, operation: "delete", record: feedClosure() })).toEqual({
      ok: false,
      recordId: head.recordId,
      reason: "a delete carries no record",
    });
    expect(readInboundEntry({ ...head, operation: "create" })).toMatchObject({
      ok: false,
      reason: "a create carries its record",
    });
    expect(readInboundEntry({ ...head, recordClass: "event", operation: "create" })).toMatchObject({
      ok: false,
    });
    expect(readInboundEntry("x")).toEqual({ ok: false, reason: "malformed entry" });
  });
});
