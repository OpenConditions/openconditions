import type { Observation } from "@openconditions/core";
import { describe, expect, it } from "vitest";
import { toRow } from "../pipeline/write-postgis.js";

/** A minimal valid flow reading; overrides exercise the timestamp coercion. */
function baseObs(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "ca-on-511:1",
    source: "ca-on-511",
    sourceFormat: "ibi511",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    speedKph: 40,
    value: 40,
    unit: "km/h",
    aggregation: "live",
    status: "active",
    geometry: { type: "Point", coordinates: [-79.38, 43.65] },
    origin: { kind: "feed", attribution: {} },
    dataUpdatedAt: "2026-06-25T10:00:00.000Z",
    fetchedAt: "2026-06-25T10:00:00.000Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

describe("toRow timestamp coercion (defense-in-depth)", () => {
  it("coerces epoch-seconds valid_from/valid_to to ISO", () => {
    const r = toRow(baseObs({ validFrom: 1757502000, validTo: "1757502000" }));
    expect(r.valid_from).toBe("2025-09-10T11:00:00.000Z");
    expect(r.valid_to).toBe("2025-09-10T11:00:00.000Z");
  });

  it("nulls an unparseable valid_from/valid_to rather than letting it abort the batch", () => {
    const r = toRow(baseObs({ validFrom: "garbage", validTo: "" }));
    expect(r.valid_from).toBeNull();
    expect(r.valid_to).toBeNull();
  });

  it("keeps the NOT NULL data_updated_at/fetched_at valid even when the source value is malformed", () => {
    const r = toRow(baseObs({ dataUpdatedAt: "garbage", fetchedAt: "garbage" }));
    expect(r.data_updated_at).not.toBeNull();
    expect(r.fetched_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(r.data_updated_at))).toBe(false);
    expect(Number.isNaN(Date.parse(r.fetched_at))).toBe(false);
  });
});

describe("content_hash includes expires_at", () => {
  it("produces different hashes for observations differing only in expiresAt", () => {
    const a = toRow(baseObs({ expiresAt: "2026-06-25T12:00:00.000Z" }));
    const b = toRow(baseObs({ expiresAt: "2026-06-25T18:00:00.000Z" }));
    expect(a.content_hash).not.toBe(b.content_hash);
  });
});

describe("commons fields — toRow mapping", () => {
  it("maps every commons field to its column", () => {
    const r = toRow(
      baseObs({
        instanceId: "inst-1",
        canonicalId: "canon-1",
        fuzziness: "low_res",
        privacyClass: "authoritative",
        kAnonymity: 5,
        dpEpsilon: 0.5,
        dpDelta: 0.001,
        informed: { modes: ["bus"], routes: ["r1"], stops: ["s1"], trips: ["t1"] },
        sourceUri: "https://example.test/x",
        sourceLicense: "CC-BY-4.0",
      }),
    ) as unknown as Record<string, unknown>;
    expect(r.instance_id).toBe("inst-1");
    expect(r.canonical_id).toBe("canon-1");
    expect(r.fuzziness).toBe("low_res");
    expect(r.privacy_class).toBe("authoritative");
    expect(r.k_anonymity).toBe(5);
    expect(r.dp_epsilon).toBe(0.5);
    expect(r.dp_delta).toBe(0.001);
    expect(r.informed).toEqual({
      modes: ["bus"],
      routes: ["r1"],
      stops: ["s1"],
      trips: ["t1"],
    });
    expect(r.source_uri).toBe("https://example.test/x");
    expect(r.source_license).toBe("CC-BY-4.0");
  });

  it("leaves the commons columns null when the observation carries no commons fields", () => {
    const r = toRow(baseObs()) as unknown as Record<string, unknown>;
    for (const col of [
      "instance_id",
      "canonical_id",
      "fuzziness",
      "privacy_class",
      "k_anonymity",
      "dp_epsilon",
      "dp_delta",
      "informed",
      "source_uri",
      "source_license",
    ]) {
      expect(r[col]).toBeNull();
    }
  });

  it("writes none of the event or crowd columns", () => {
    const r = toRow(baseObs()) as unknown as Record<string, unknown>;
    for (const col of [
      "type",
      "subtype",
      "category",
      "severity",
      "severity_source",
      "headline",
      "description",
      "severity_level",
      "phenomenon_fingerprint",
      "replaces",
      "corroborations",
      "confidence_score",
      "evidence_state",
      "routing_eligible",
      "flagged_at",
    ]) {
      expect(r).not.toHaveProperty(col);
    }
  });
});

describe("commons fields — content_hash policy", () => {
  // Pinned hash of a plain (no commons fields) flow reading, the only feed
  // observation still written here. `sourceFormat` is part of the content
  // material; the identity/derived fields stay excluded (asserted below).
  const GOLDEN_PLAIN_HASH = "543fd223c6618f3909dbbcfd8c088572efbf92276caf52406ee8d22d90d7370b";

  it("is byte-identical for a no-commons-fields observation", () => {
    expect(toRow(baseObs()).content_hash).toBe(GOLDEN_PLAIN_HASH);
  });

  it("is unaffected by the derived/identity fields (excluded from the hash material)", () => {
    const withDerived = toRow(
      baseObs({
        instanceId: "inst-1",
        canonicalId: "canon-1",
        privacyClass: "authoritative",
      }),
    );
    expect(withDerived.content_hash).toBe(GOLDEN_PLAIN_HASH);
  });

  it("changes when a content-bearing field (sourceLicense) changes", () => {
    const a = toRow(baseObs({ sourceLicense: "CC0-1.0" }));
    const b = toRow(baseObs({ sourceLicense: "CC-BY-4.0" }));
    expect(a.content_hash).not.toBe(b.content_hash);
    expect(a.content_hash).not.toBe(GOLDEN_PLAIN_HASH);
  });
});
