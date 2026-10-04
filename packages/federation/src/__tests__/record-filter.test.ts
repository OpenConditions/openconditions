import { describe, expect, it } from "vitest";
import {
  applyRecordFilter,
  type FederatedRecord,
  type RecordFilter,
  type RecordOutboxEntry,
} from "../index.js";

const NOW = "2026-10-03T12:00:00Z";

function closure(license: string, local: string): RecordOutboxEntry {
  const record = {
    id: `oc:situation:nl-ndw-events:${local}`,
    class: "situation",
    kind: "closure",
    domain: "roads",
    location: { geometry: { type: "Point", coordinates: [4.9, 52.37] } },
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw-events",
      accessMode: "bulk",
      attribution: { license },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: "2026-10-03T11:59:00Z" },
  } as unknown as FederatedRecord;
  return {
    seq: 1,
    txid: "1000",
    operation: "create",
    recordClass: "situation",
    recordId: record.id,
    canonicalId: null,
    kind: "closure",
    domain: "roads",
    createdAt: NOW,
    record,
  };
}

describe("the subscriber filter's licence gate", () => {
  const entries = [
    closure("CC-BY-4.0", "open"),
    closure("NOASSERTION", "unasserted"),
    closure("ODbL-1.0", "share-alike"),
  ];
  const ids = (out: RecordOutboxEntry[]) => out.map((e) => e.recordId);

  it("passes only records whose licence is public, whatever the filter", () => {
    expect(ids(applyRecordFilter(entries, undefined, NOW))).toEqual([
      "oc:situation:nl-ndw-events:open",
    ]);
    expect(ids(applyRecordFilter(entries, { bbox: [4, 52, 6, 53] }, NOW))).toEqual([
      "oc:situation:nl-ndw-events:open",
    ]);
  });

  it("offers no filter field that widens the licence gate", () => {
    const widened = { publicOnly: false, permissiveOnly: false } as unknown as RecordFilter;
    expect(ids(applyRecordFilter(entries, widened, NOW))).toEqual([
      "oc:situation:nl-ndw-events:open",
    ]);
  });
});
