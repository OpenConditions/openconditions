import { crowdObservationId } from "@openconditions/contrib-core";
import type { Observation } from "@openconditions/core";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { describe, expect, it } from "vitest";
import { dailyGeoParquet, toPublishedArchiveRows } from "../archive.js";
import { measurement, roadEvent } from "./fixture.js";

const NOW = "2026-07-01T00:00:00Z";

/** A reporter thumbprint that must NEVER appear in any published projection —
 * neither in origin.reporter nor embedded in the observation id. */
const SENTINEL_KEY_ID = "SECRET_REPORTER_KEY_ABC123";

/**
 * A crowd observation built the way landing builds one: the id is the real
 * de-identified `crowdObservationId(keyId, nonce)`, so if id minting ever
 * regressed to embed the raw keyId, the byte-scan assertions below would catch
 * the leak. Its reporter block carries the sentinel keyId + signature that the
 * central strip must remove.
 */
async function crowdEvent(over: Parameters<typeof roadEvent>[0] = {}): Promise<Observation> {
  const id = await crowdObservationId(SENTINEL_KEY_ID, "archive-nonce-0001");
  return roadEvent({
    id,
    source: "crowd",
    sourceFormat: "crowd",
    origin: {
      kind: "crowd",
      attribution: { provider: "OpenConditions crowd", license: "CC0-1.0" },
      reporter: { keyId: SENTINEL_KEY_ID, signature: "SECRET_SIGNATURE_XYZ" },
    },
    privacyClass: "crowd_pseudonym",
    evidenceState: "corroborated",
    ...over,
  }) as Observation;
}

describe("toPublishedArchiveRows", () => {
  it("projects an event to the flat published columns", () => {
    const rows = toPublishedArchiveRows([roadEvent({ id: "e1" })], NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({
      id: "e1",
      source: "ndw",
      domain: "roads",
      kind: "event",
      type: "accident",
      metric: null,
      severity: "high",
      headline: "Accident on A2",
      originKind: "feed",
      attributionProvider: "NDW",
      attributionLicense: "CC0-1.0",
      attributionUrl: "https://www.ndw.nu",
    });
    expect(r.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] });
  });

  it("projects a measurement with metric set and event fields null", () => {
    const rows = toPublishedArchiveRows([measurement({ id: "m1", metric: "flow" })], NOW);
    expect(rows[0]).toMatchObject({
      kind: "measurement",
      metric: "flow",
      type: null,
      headline: null,
    });
  });

  it("excludes rows already expired at now, keeps future-expiry rows", () => {
    const rows = toPublishedArchiveRows(
      [
        roadEvent({ id: "gone", expiresAt: "2026-06-30T23:59:59Z" }),
        roadEvent({ id: "live", expiresAt: "2026-07-02T00:00:00Z" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.id)).toEqual(["live"]);
  });

  it("excludes a row whose expiresAt is exactly now (boundary, inclusive)", () => {
    const rows = toPublishedArchiveRows([roadEvent({ id: "edge", expiresAt: NOW })], NOW);
    expect(rows).toHaveLength(0);
  });

  it("excludes rows whose validTo has passed", () => {
    const rows = toPublishedArchiveRows(
      [roadEvent({ id: "over", validTo: "2026-06-01T00:00:00Z" })],
      NOW
    );
    expect(rows).toHaveLength(0);
  });

  it("excludes tombstoned (archived) and cancelled rows", () => {
    const rows = toPublishedArchiveRows(
      [
        roadEvent({ id: "tomb", status: "archived" }),
        roadEvent({ id: "cancel", status: "cancelled" }),
        roadEvent({ id: "ok", status: "active" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });

  it("drops share-alike-licensed rows via the permissive filter", () => {
    const rows = toPublishedArchiveRows(
      [
        roadEvent({
          id: "sa",
          origin: { kind: "feed", attribution: { provider: "osm", license: "ODbL-1.0" } },
        }),
        roadEvent({ id: "perm" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.id)).toEqual(["perm"]);
  });

  it("strips crowd reporter identity but keeps privacyClass and originKind", async () => {
    const rows = toPublishedArchiveRows([await crowdEvent()], NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.originKind).toBe("crowd");
    expect(r.privacyClass).toBe("crowd_pseudonym");
    // The reporter block never travels, and the de-identified id embeds no keyId:
    // no field of the archived row may carry the keyId or signature.
    expect(JSON.stringify(r)).not.toContain(SENTINEL_KEY_ID);
    expect(JSON.stringify(r)).not.toContain("SECRET_SIGNATURE_XYZ");
  });

  it("includes legacy feed rows with no explicit privacyClass", () => {
    const rows = toPublishedArchiveRows(
      [roadEvent({ id: "legacy", privacyClass: undefined })],
      NOW
    );
    expect(rows.map((r) => r.id)).toEqual(["legacy"]);
  });

  it("excludes a non-feed row with no privacyClass (fail-closed carve-out)", async () => {
    // A crowd row that somehow lacks a class must NOT get the feed carve-out.
    const classless = (await crowdEvent()) as Observation;
    delete (classless as { privacyClass?: unknown }).privacyClass;
    const rows = toPublishedArchiveRows([classless], NOW);
    expect(rows).toHaveLength(0);
  });

  it("drops any row bearing an unreleased/staging privacy marker", () => {
    // A probe-staging class does not exist in the v1 enum yet; simulate the seam
    // the probe pipeline will add — an unknown, non-released marker must be
    // excluded by construction.
    const staged = roadEvent({ id: "probe" }) as Observation;
    (staged as { privacyClass: string }).privacyClass = "dp_staging";
    const rows = toPublishedArchiveRows([staged, roadEvent({ id: "ok" })], NOW);
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("dailyGeoParquet", () => {
  async function readBack(buf: Uint8Array): Promise<Record<string, unknown>[]> {
    // hyparquet recognizes the GeoParquet "geo" metadata and decodes the WKB
    // geometry column back to GeoJSON; STRING columns come back as strings.
    return (await parquetReadObjects({ file: buf.buffer as ArrayBuffer })) as Record<
      string,
      unknown
    >[];
  }

  it("round-trips the published columns and row count", async () => {
    const input = [roadEvent({ id: "e1" }), measurement({ id: "m1", metric: "flow" })];
    const buf = await dailyGeoParquet(input, NOW);
    const rows = await readBack(buf);
    expect(rows.map((r) => r.id).sort()).toEqual(["e1", "m1"]);
    const e1 = rows.find((r) => r.id === "e1")!;
    expect(e1.type).toBe("accident");
    expect(e1.severity).toBe("high");
    expect(e1.attributionProvider).toBe("NDW");
  });

  it("writes the GeoParquet 1.0 geo metadata key", async () => {
    const buf = await dailyGeoParquet([roadEvent({ id: "e1" })], NOW);
    const meta = parquetMetadata(buf.buffer as ArrayBuffer);
    const geo = meta.key_value_metadata?.find((k) => k.key === "geo");
    expect(geo).toBeDefined();
    const parsed = JSON.parse(geo!.value!) as {
      version: string;
      primary_column: string;
      columns: Record<string, { encoding: string; geometry_types: string[] }>;
    };
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.primary_column).toBe("geometry");
    expect(parsed.columns.geometry.encoding).toBe("WKB");
    expect(parsed.columns.geometry.geometry_types).toContain("Point");
  });

  it("round-trips geometry losslessly through WKB", async () => {
    const geom = {
      type: "LineString" as const,
      coordinates: [
        [13.4, 52.5],
        [13.6, 52.7],
      ],
    };
    const buf = await dailyGeoParquet([roadEvent({ id: "e1", geometry: geom })], NOW);
    const rows = await readBack(buf);
    expect(rows[0]!.geometry).toEqual(geom);
  });

  it("never serializes an excluded row, and never leaks a reporter identity", async () => {
    const crowd = await crowdEvent();
    const input: Observation[] = [
      roadEvent({ id: "keep" }) as Observation,
      roadEvent({ id: "expired", expiresAt: "2026-06-01T00:00:00Z" }) as Observation,
      roadEvent({ id: "tomb", status: "archived" }) as Observation,
      roadEvent({
        id: "sharealike",
        origin: { kind: "feed", attribution: { provider: "osm", license: "ODbL-1.0" } },
      }) as Observation,
      crowd,
    ];
    const buf = await dailyGeoParquet(input, NOW);
    const rows = await readBack(buf);
    expect(rows.map((r) => r.id).sort()).toEqual([crowd.id, "keep"].sort());

    // Belt-and-suspenders: the reporter keyId/signature bytes — and the keyId
    // that a regressed id would embed — appear nowhere in the serialized file.
    const asText = Buffer.from(buf).toString("latin1");
    expect(asText).not.toContain(SENTINEL_KEY_ID);
    expect(asText).not.toContain("SECRET_SIGNATURE_XYZ");
  });

  it("produces a valid empty archive when no row survives the filter", async () => {
    const buf = await dailyGeoParquet([roadEvent({ id: "tomb", status: "archived" })], NOW);
    const rows = await readBack(buf);
    expect(rows).toHaveLength(0);
    const meta = parquetMetadata(buf.buffer as ArrayBuffer);
    expect(meta.key_value_metadata?.some((k) => k.key === "geo")).toBe(true);
  });
});
