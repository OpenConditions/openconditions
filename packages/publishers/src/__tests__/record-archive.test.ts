import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { describe, expect, it } from "vitest";
import {
  type ArchivableRecord,
  publishedRecords,
  recordArchiveBuffer,
  recordArchiveColumns,
} from "../record-archive.js";

const NOW = "2026-10-01T12:00:00Z";
const SECRET_KEY = "SECRET_REPORTER_KEY_ABC123";

function record(
  overrides: Partial<ArchivableRecord> & Record<string, unknown> = {},
): ArchivableRecord {
  return {
    id: "oc:situation:nl-ndw:SIT-1",
    class: "situation",
    kind: "closure",
    type: "closure",
    domain: "roads",
    temporality: "live",
    canonicalId: "a".repeat(64),
    revision: 1,
    recordedAt: NOW,
    location: { geometry: { type: "Point", coordinates: [4.9, 52.37] } },
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw",
      accessMode: "bulk",
      attribution: { provider: "NDW", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: {},
    severity: { label: "major" },
    certainty: "observed",
    validity: { status: "active", start: "2026-10-01T10:00:00Z" },
    headline: [{ lang: "nl", text: "Afgesloten" }],
    ...overrides,
  };
}

const crowd = (state: string, expiresAt = "2026-10-01T13:00:00Z") =>
  record({
    id: "oc:situation:oc.example.org:abc",
    kind: "incident",
    type: "accident",
    provenance: {
      origin: "crowd",
      sourceId: "crowd",
      accessMode: "bulk",
      attribution: { provider: "oc.example.org", license: "CC0-1.0" },
      reporter: { keyId: SECRET_KEY },
      privacy: { class: "crowd_pseudonym" },
    },
    freshness: { expiresAt },
    evidence: { state },
  });

describe("the archive of model records", () => {
  it("mirrors only what a peer could receive and what is still current", () => {
    const kept = publishedRecords(
      "situation",
      [
        record(),
        record({ id: "ended", validity: { status: "ended", start: "2026-09-30T10:00:00Z" } }),
        record({
          id: "past",
          validity: {
            status: "active",
            start: "2026-09-30T10:00:00Z",
            end: "2026-10-01T11:00:00Z",
          },
        }),
        record({ id: "gone", tombstone: { reason: "withdrawn", at: NOW } }),
        record({
          id: "cached",
          provenance: { ...record().provenance, accessMode: "on_demand" } as never,
        }),
        crowd("self_reported"),
        crowd("corroborated", "2026-10-01T11:59:00Z"),
        crowd("corroborated"),
        record({ id: "oc:feature:x:1", class: "feature" }),
      ],
      NOW,
    );
    expect(kept.map((r) => r.id)).toEqual([
      "oc:situation:nl-ndw:SIT-1",
      "oc:situation:oc.example.org:abc",
    ]);
    expect(JSON.stringify(kept)).not.toContain(SECRET_KEY);
  });

  it("withholds a source's extras unless the source federates them", () => {
    const tokens = record({ extras: { situationRecordExtension: "x" } });
    const [plain] = publishedRecords("situation", [tokens], NOW);
    expect(plain).not.toHaveProperty("extras");
    const [shared] = publishedRecords("situation", [tokens], NOW, {
      federateExtras: (sourceId) => sourceId === "nl-ndw",
    });
    expect(shared!["extras"]).toEqual({ situationRecordExtension: "x" });
    const buffer = recordArchiveBuffer("situation", [tokens], NOW);
    expect(new TextDecoder().decode(buffer)).not.toContain("situationRecordExtension");
  });

  it("writes one GeoParquet file per class, with its promoted columns and the record", async () => {
    const buffer = recordArchiveBuffer("situation", [record(), crowd("corroborated")], NOW);
    const file = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const metadata = parquetMetadata(file);
    expect(metadata.key_value_metadata?.find((kv) => kv.key === "geo")).toBeDefined();
    const rows = await parquetReadObjects({ file, utf8: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "oc:situation:nl-ndw:SIT-1",
      kind: "closure",
      severity: "major",
      validity_status: "active",
      valid_from: "2026-10-01T10:00:00Z",
      headline: "Afgesloten",
    });
    expect(JSON.parse(rows[1]!["record"] as string).provenance.reporter).toBeUndefined();
    expect(new TextDecoder().decode(buffer)).not.toContain(SECRET_KEY);
  });

  it("archives a feature that has no position with an empty geometry", async () => {
    const plough = record({
      id: "oc:feature:us-ia-dot:plow-1",
      class: "feature",
      kind: "service_vehicle",
      type: "snowplow",
      domain: "vehicles",
      temporality: "static",
      lifecycle: "operational",
      location: { geometry: null },
    });
    const buffer = recordArchiveBuffer("feature", [plough], NOW);
    const file = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const [row] = await parquetReadObjects({ file, utf8: true });
    expect(row).toMatchObject({ id: "oc:feature:us-ia-dot:plow-1", lifecycle: "operational" });
    expect(row!["geometry"]).toBeNull();
  });

  it("promotes each class's own columns", () => {
    const names = (cls: "situation" | "feature" | "observation" | "offer") =>
      recordArchiveColumns(cls).map((c) => c.name);
    expect(names("observation")).toEqual(
      expect.arrayContaining([
        "property",
        "subject_key",
        "value_num",
        "currency",
        "phenomenon_start",
      ]),
    );
    expect(names("offer")).toEqual(expect.arrayContaining(["subject_id", "valid_to"]));
    expect(names("feature")).toEqual(expect.arrayContaining(["lifecycle", "name", "geometry"]));
  });

  it("writes an observation's reading as a number, its unit and its subject", async () => {
    const price = record({
      id: "oc:observation:es-minetur:p",
      class: "observation",
      kind: "observation",
      type: undefined,
      domain: "fuel",
      property: "fuel.price",
      subject: { kind: "feature", featureId: "oc:feature:es-minetur:4375", componentKey: "e5" },
      result: { type: "money", amount: "1.479", currency: "EUR", per: "L" },
      phenomenonTime: { instant: "2026-10-01T11:00:00Z" },
    });
    const buffer = recordArchiveBuffer("observation", [price], NOW);
    const file = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const [row] = await parquetReadObjects({ file, utf8: true });
    expect(row).toMatchObject({
      property: "fuel.price",
      subject_key: "feature:oc:feature:es-minetur:4375#e5",
      result_type: "money",
      value_num: 1.479,
      unit: "L",
      currency: "EUR",
    });
  });
});
