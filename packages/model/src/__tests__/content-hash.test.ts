import { describe, expect, it } from "vitest";
import { contentHash, contentOf } from "../content-hash.js";
import { sealRecord } from "../registry/seal.js";
import { incidentDraft, registry, stored } from "./fixtures.js";

describe("content hash", () => {
  it("ignores derived fields and provenance hop metadata", () => {
    const rec = stored(incidentDraft());
    const hash = contentHash(rec);
    expect(contentHash({ ...rec, revision: 7, recordedAt: "2030-01-01T00:00:00Z" })).toBe(hash);
    expect(contentHash({ ...rec, freshness: { fetchedAt: "2030-01-01T00:00:00Z" } })).toBe(hash);
    expect(
      contentHash({
        ...rec,
        provenance: { ...rec.provenance, rawRef: { hash: "a".repeat(64) }, instanceId: "other" },
      }),
    ).toBe(hash);
    expect(contentHash(incidentDraft())).toBe(hash);
  });

  it("changes when content changes", () => {
    const rec = stored(incidentDraft());
    expect(contentHash({ ...rec, severity: { label: "minor", source: "declared" } })).not.toBe(
      contentHash(rec),
    );
    expect(contentHash({ ...rec, extras: { x: 1 } })).not.toBe(contentHash(rec));
  });

  it("refuses keys it has not classified", () => {
    expect(() => contentOf({ ...incidentDraft(), surprise: 1 })).toThrow(
      /unclassified key "surprise"/,
    );
  });
});

describe("sealRecord", () => {
  it("stamps derived fields and validates the stored record", () => {
    const sealed = sealRecord(registry, incidentDraft(), {
      instanceId: "maps.example.org",
      revision: 1,
      recordedAt: "2026-09-18T10:00:01Z",
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value).toMatchObject({
      domain: "roads",
      revision: 1,
      provenance: { instanceId: "maps.example.org" },
    });
    expect(sealed.value["contentHash"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
