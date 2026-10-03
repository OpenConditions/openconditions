import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { LookupFn } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSource } from "../pipeline/run.js";
import { repoFeed, testFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * Complete-snapshot acceptance against a real disposable PostGIS. The point of
 * these cases is the difference between "the publisher withdrew this record"
 * and "we failed to read this record": only the former may withdraw a
 * situation.
 */

const FIXTURE_URL = new URL(
  "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
  import.meta.url,
);

const V2_BASE = "https://tie.digitraffic.fi/api/traffic-message/v2";
const ROADWORKS = `${V2_BASE}/roadworks`;
const ANNOUNCEMENTS = `${V2_BASE}/traffic-announcements`;
const WEIGHTS = `${V2_BASE}/weight-restrictions`;
const EXEMPTED = `${V2_BASE}/exempted-transports`;

/**
 * A local Finland descriptor, so this suite proves the acceptance behaviour
 * without depending on the shipped feed being activated yet.
 */
const feed = testFeed({
  id: "fi-digitraffic-events",
  operator: "digitraffic",
  name: "Digitraffic (Finland)",
  format: "digitraffic",
  endpoints: {
    main: {
      urls: [ANNOUNCEMENTS, ROADWORKS, WEIGHTS, EXEMPTED],
      headers: { "Digitraffic-User": "OpenConditions/1.0", "Accept-Encoding": "gzip" },
      cadenceSec: 120,
    },
  },
  snapshot: { completeness: "complete", recordsPath: "features" },
  freshnessWindowSec: 600,
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
});

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

const EMPTY = { type: "FeatureCollection", features: [] };

function roadworks(): { type: string; features: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as {
    type: string;
    features: Array<Record<string, unknown>>;
  };
}

/** Serve each configured partition by URL; only roadworks carries records. */
function serve(payloadForRoadworks: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    const body = url.startsWith(ROADWORKS) ? payloadForRoadworks : EMPTY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.record_binding, conditions.record_segment,
    conditions.binding_queue CASCADE`;
  await sql`DELETE FROM conditions.source_status WHERE source = 'fi-digitraffic-events'`;
});

const fiId = (local: string) => `oc:situation:fi-digitraffic-events:${local}`;

/** The live situations of `source`, with their content hashes. */
async function liveRows(source: string): Promise<Array<{ id: string; content_hash: string }>> {
  return sql<Array<{ id: string; content_hash: string }>>`
    SELECT id, content_hash FROM conditions.situation
    WHERE source_id = ${source} AND tombstoned_at IS NULL ORDER BY id`;
}

/** The situations of `source` ended by the reason given. */
async function tombstoned(source: string, reason: string): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM conditions.situation
    WHERE source_id = ${source} AND tombstone_reason = ${reason} ORDER BY id`;
  return rows.map((r) => r.id);
}

async function idsAndHashes(): Promise<Array<{ id: string; content_hash: string }>> {
  return liveRows("fi-digitraffic-events");
}

async function queued(): Promise<Array<{ record_id: string; record_revision: number }>> {
  return sql<Array<{ record_id: string; record_revision: number }>>`
    SELECT record_id, record_revision FROM conditions.binding_queue
    WHERE record_class = 'situation' ORDER BY record_id`;
}

async function seed(now: string): Promise<void> {
  const result = await runSource(feed, {
    sql,
    fetch: serve(roadworks()),
    lookup: fakeLookup,
    now: () => now,
  });
  expect(result.error).toBeUndefined();
}

describe("complete road snapshot acceptance", () => {
  it("publishes every accepted record with its restriction facts", async () => {
    const result = await runSource(feed, {
      sql,
      fetch: serve(roadworks()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.snapshot).toMatchObject({
      inputCount: 5,
      uniqueCount: 5,
      accepted: 5,
      terminal: 0,
      unlocatable: 0,
      duplicates: 0,
    });
    expect(result.snapshot!.restrictionFacts).toBeGreaterThanOrEqual(8);
    const rows = await idsAndHashes();
    expect(rows.map((r) => r.id)).toEqual([
      fiId("GUID50461965"),
      fiId("GUID50465935"),
      fiId("GUID50466626"),
      fiId("GUID50468844"),
      fiId("GUID50470575"),
    ]);
    const limits = await sql<Array<{ value: { value: { value: number; unit: string } } }>>`
      SELECT value FROM conditions.situation_effect
      WHERE situation_id = ${fiId("GUID50465935")} AND kind = 'dimension_limit'`;
    expect(limits[0]!.value.value).toEqual({ value: 26000, unit: "kg" });
  }, 120_000);

  it("rejects a candidate in which a still-published record lost its geometry", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();
    expect(before).toHaveLength(5);
    const status = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic-events'`;

    const lostGeometry = roadworks();
    // Keep the id, remove only its geometry: the publisher still serves it.
    lostGeometry.features = lostGeometry.features.map((feature) =>
      (feature["properties"] as Record<string, unknown>)["situationId"] === "GUID50465935"
        ? { ...feature, geometry: null }
        : feature,
    );
    const failed = await runSource(feed, {
      sql,
      fetch: serve(lostGeometry),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(failed.error).toMatch(/unlocatable/);
    expect(await idsAndHashes()).toEqual(before);
    const after = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic-events'`;
    expect(after[0]!.last_success_at?.toISOString()).toBe(
      status[0]!.last_success_at?.toISOString(),
    );
  }, 120_000);

  it("withdraws a record only when it is absent from an accepted snapshot", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const removed = roadworks();
    removed.features = removed.features.filter(
      (feature) =>
        (feature["properties"] as Record<string, unknown>)["situationId"] !== "GUID50465935",
    );
    const result = await runSource(feed, {
      sql,
      fetch: serve(removed),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(1);
    expect((await idsAndHashes()).map((r) => r.id)).not.toContain(fiId("GUID50465935"));
    expect(await tombstoned("fi-digitraffic-events", "withdrawn")).toEqual([fiId("GUID50465935")]);
  }, 120_000);

  it("clears the source for a valid complete empty snapshot", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const empty = await runSource(feed, {
      sql,
      fetch: serve(EMPTY),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(empty.error).toBeUndefined();
    expect(await idsAndHashes()).toHaveLength(0);
    expect(await tombstoned("fi-digitraffic-events", "withdrawn")).toHaveLength(5);
  }, 120_000);

  it("clears the source for an all-terminal snapshot without a zero-result failure", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const terminal = roadworks();
    // Synthetic: the capture contained no terminal record.
    terminal.features = terminal.features.map((feature) => ({
      ...feature,
      properties: { ...(feature["properties"] as object), earlyClosing: "canceled" },
    }));
    const result = await runSource(feed, {
      sql,
      fetch: serve(terminal),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.snapshot).toMatchObject({ accepted: 0, terminal: 5 });
    expect(await idsAndHashes()).toHaveLength(0);
  }, 120_000);

  it("preserves the publication when one partition fails", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();
    const partial = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.startsWith(WEIGHTS)) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify(url.startsWith(ROADWORKS) ? roadworks() : EMPTY), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const result = await runSource(feed, {
      sql,
      fetch: partial,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeDefined();
    expect(await idsAndHashes()).toEqual(before);
  }, 120_000);

  it("preserves the publication for invalid JSON and for a malformed record", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();

    const brokenJson = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      return new Response(url.startsWith(ROADWORKS) ? "{not json" : JSON.stringify(EMPTY), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    expect(
      (
        await runSource(feed, {
          sql,
          fetch: brokenJson,
          lookup: fakeLookup,
          now: () => "2026-09-12T07:16:00.000Z",
        })
      ).error,
    ).toBeDefined();
    expect(await idsAndHashes()).toEqual(before);

    const malformed = roadworks();
    malformed.features = malformed.features.map((feature, index) =>
      index === 0
        ? { ...feature, properties: { ...(feature["properties"] as object), situationId: null } }
        : feature,
    );
    expect(
      (
        await runSource(feed, {
          sql,
          fetch: serve(malformed),
          lookup: fakeLookup,
          now: () => "2026-09-12T07:17:00.000Z",
        })
      ).error,
    ).toMatch(/missing_identity/);
    expect(await idsAndHashes()).toEqual(before);
  }, 120_000);

  it("rejects the same id served with conflicting equal-ranked content", async () => {
    const conflicting = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.startsWith(ROADWORKS)) {
        return new Response(JSON.stringify(roadworks()), { status: 200 });
      }
      if (url.startsWith(WEIGHTS)) {
        const other = roadworks();
        // Same id and version, different headline: an unresolvable conflict.
        other.features = [
          {
            ...other.features[0]!,
            properties: {
              ...(other.features[0]!["properties"] as object),
              announcements: [{ language: "fi", title: "Eri otsikko" }],
            },
          },
        ];
        return new Response(JSON.stringify(other), { status: 200 });
      }
      return new Response(JSON.stringify(EMPTY), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runSource(feed, {
      sql,
      fetch: conflicting,
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(result.error).toMatch(/conflict/);
    expect(await idsAndHashes()).toHaveLength(0);
  }, 120_000);

  it("accepts a new unlocatable record without publishing a fabricated location", async () => {
    const withUnlocatable = roadworks();
    withUnlocatable.features = withUnlocatable.features.map((feature) =>
      (feature["properties"] as Record<string, unknown>)["situationId"] === "GUID50466626"
        ? { ...feature, geometry: null }
        : feature,
    );
    const result = await runSource(feed, {
      sql,
      fetch: serve(withUnlocatable),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.snapshot).toMatchObject({ accepted: 4, unlocatable: 1 });
    const rows = await idsAndHashes();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id)).not.toContain(fiId("GUID50466626"));
    const [unplaced] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM conditions.situation WHERE id = ${fiId("GUID50466626")}`;
    expect(unplaced!.n).toBe(0);
  }, 120_000);

  it("advances checked time on an unchanged snapshot without changing content", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();
    const beforeQueue = await queued();
    expect(beforeQueue).toHaveLength(5);

    const again = await runSource(feed, {
      sql,
      fetch: serve(roadworks()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:20:00.000Z",
    });
    expect(again.error).toBeUndefined();
    expect(again.count).toBe(0);
    expect(await idsAndHashes()).toEqual(before);
    expect(await queued()).toEqual(beforeQueue);
    const status = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic-events'`;
    expect(status[0]!.last_success_at).not.toBeNull();
  }, 120_000);

  it("changes the content hash and re-queues binding when a restriction changes", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();

    const changed = roadworks();
    changed.features = changed.features.map((feature) => {
      const props = feature["properties"] as Record<string, unknown>;
      if (props["situationId"] !== "GUID50465935") return feature;
      const clone = structuredClone(feature) as Record<string, unknown>;
      const announcement = (
        (clone["properties"] as Record<string, unknown>)["announcements"] as Array<
          Record<string, unknown>
        >
      )[0]!;
      const phases = announcement["roadWorkPhases"] as Array<Record<string, unknown>>;
      const restrictions = phases[1]!["restrictions"] as Array<Record<string, unknown>>;
      // Synthetic: the publisher raises the weight limit to 30 t.
      for (const restriction of restrictions) {
        if (restriction["type"] === "vehicle gross weight limit") {
          (restriction["restriction"] as Record<string, unknown>)["quantity"] = 30;
        }
      }
      (clone["properties"] as Record<string, unknown>)["version"] = 32;
      (clone["properties"] as Record<string, unknown>)["versionTime"] = "2026-09-12T07:00:00.000Z";
      return clone;
    });

    const result = await runSource(feed, {
      sql,
      fetch: serve(changed),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:18:00.000Z",
    });
    expect(result.error).toBeUndefined();
    const after = await idsAndHashes();
    const id = fiId("GUID50465935");
    expect(after.find((r) => r.id === id)!.content_hash).not.toBe(
      before.find((r) => r.id === id)!.content_hash,
    );
    expect((await queued()).filter((q) => q.record_id === id)).toEqual([
      { record_id: id, record_revision: 2 },
    ]);
  }, 120_000);
});

/**
 * The same acceptance rules against the shipped NDW descriptor and the reviewed
 * reduced capture, gzip-compressed exactly as the publisher serves it.
 */
describe("complete road snapshot acceptance — NDW", () => {
  const NDW = "nl-ndw-events";
  const ndwXml = readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml",
      import.meta.url,
    ),
    "utf8",
  );
  // The catalogue's NDW descriptor: its id is what the DATEX restriction
  // contract is verified for.
  const ndwFeed = repoFeed(NDW);

  /** Serve one gzip XML body, as the real endpoint does. */
  function serveXml(body: string, status = 200): typeof fetch {
    return (async () =>
      new Response(status === 200 ? new Uint8Array(gzipSync(Buffer.from(body, "utf8"))) : null, {
        status,
        headers: { "content-type": "application/xml" },
      })) as unknown as typeof fetch;
  }

  async function ndwRows(): Promise<Array<{ id: string; content_hash: string }>> {
    return liveRows(NDW);
  }

  const ndwId = (local: string) => `oc:situation:${NDW}:${local}`;

  async function seedNdw(now: string): Promise<void> {
    const result = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(ndwXml),
      lookup: fakeLookup,
      now: () => now,
    });
    expect(result.error).toBeUndefined();
  }

  beforeEach(async () => {
    await sql`DELETE FROM conditions.source_status WHERE source = ${NDW}`;
  });

  it("accepts every record of the reviewed capture and keeps the height condition", async () => {
    const result = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(ndwXml),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.snapshot).toMatchObject({
      inputCount: 6,
      uniqueCount: 6,
      accepted: 6,
      terminal: 0,
      unlocatable: 0,
      duplicates: 0,
    });
    // The six DATEX records fold into the four situations they belong to.
    expect((await ndwRows()).map((r) => r.id)).toEqual([
      ndwId("NDW08_2e188db4-9bff-492d-bf28-90e17bffac8c_SIT"),
      ndwId("NLRWS_0005382945"),
      ndwId("NLRWS_0005406494"),
      ndwId("RWS01_SM1080891_D2_WWA"),
    ]);
    const [height] = await sql<
      Array<{ applicability: { include: Array<{ when: unknown[] }> }; provenance: unknown }>
    >`
      SELECT e.value -> 'applicability' AS applicability,
             s.record -> 'provenance' AS provenance
        FROM conditions.situation_effect e
        JOIN conditions.situation s ON s.id = e.situation_id
       WHERE e.situation_id = ${ndwId("RWS01_SM1080891_D2_WWA")}
         AND e.effect_id = 'RWS01_M1080891_NARROW_LANES_D2_WWA/closure'`;
    expect(height!.applicability.include[0]!.when[0]).toEqual({
      dimension: "height",
      operator: "gt",
      value: { value: 4.5, unit: "m" },
    });
    // The trusted descriptor supplies rights, never the payload.
    expect(height!.provenance).toMatchObject({
      attribution: {
        license: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        provider: "NDW / Rijkswaterstaat",
      },
    });
  }, 120_000);

  it("clears the source for a valid complete empty publication", async () => {
    await seedNdw("2026-09-12T07:14:00.000Z");
    const empty = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(ndwXml.replace(/<sit:situation\b[\s\S]*<\/sit:situation>/, "")),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(empty.error).toBeUndefined();
    expect(await ndwRows()).toHaveLength(0);
  }, 120_000);

  it("withdraws cancelled records even when the publisher removes their locations", async () => {
    await seedNdw("2026-09-12T07:14:00.000Z");
    const cancelled = ndwXml
      .replace(
        /<com:validityStatus>[^<]+<\/com:validityStatus>/g,
        "<com:validityStatus>cancelled</com:validityStatus>",
      )
      .replace(/<sit:locationReference\b[\s\S]*?<\/sit:locationReference>/g, "");
    const result = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(cancelled),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect(result.snapshot).toMatchObject({ accepted: 0, terminal: 6, unlocatable: 0 });
    expect(await ndwRows()).toHaveLength(0);
  }, 120_000);

  it("accepts an explained all-new OpenLR-only snapshot without a resolver and protects retained IDs", async () => {
    const unlocatable = ndwXml.replace(
      /<sit:locationReference\b[\s\S]*?<\/sit:locationReference>/g,
      "<sit:locationReference><openlrBinary>ABcDefGHiJkL==</openlrBinary></sit:locationReference>",
    );
    const deps = {
      sql,
      fetch: serveXml(unlocatable),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    };
    const first = await runSource(ndwFeed, deps);
    expect(first.error).toBeUndefined();
    expect(first.snapshot).toMatchObject({
      accepted: 0,
      terminal: 0,
      unlocatable: 6,
      uniqueCount: 6,
    });
    expect(await ndwRows()).toHaveLength(0);
    await seedNdw("2026-09-12T07:14:00.000Z");
    const failed = await runSource(ndwFeed, deps);
    expect(failed.error).toMatch(/unlocatable/);
    expect(await ndwRows()).toHaveLength(4);
  }, 120_000);

  it("withdraws only a record absent from an accepted snapshot", async () => {
    await seedNdw("2026-09-12T07:14:00.000Z");
    const withoutLorry = ndwXml.replace(
      /<sit:situation id="NLRWS_0005382945">[\s\S]*?<\/sit:situation>/,
      "",
    );
    const result = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(withoutLorry),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeUndefined();
    const ids = (await ndwRows()).map((r) => r.id);
    expect(ids).not.toContain(ndwId("NLRWS_0005382945"));
    expect(ids).toContain(ndwId("RWS01_SM1080891_D2_WWA"));
    expect(await tombstoned(NDW, "withdrawn")).toEqual([ndwId("NLRWS_0005382945")]);
  }, 120_000);

  it.each([
    ["truncated XML", "<mc:messageContainer>"],
    ["an HTML body served with status 200", "<html><body>maintenance</body></html>"],
  ])(
    "preserves last-good data and checked time for %s",
    async (_label, body) => {
      await seedNdw("2026-09-12T07:14:00.000Z");
      const before = await ndwRows();
      const status = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = ${NDW}`;

      const failed = await runSource(ndwFeed, {
        sql,
        fetch: serveXml(body),
        lookup: fakeLookup,
        now: () => "2026-09-12T07:16:00.000Z",
      });
      expect(failed.error).toBeDefined();
      expect(await ndwRows()).toEqual(before);
      const after = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = ${NDW}`;
      expect(after[0]!.last_success_at?.toISOString()).toBe(
        status[0]!.last_success_at?.toISOString(),
      );
    },
    120_000,
  );

  it("preserves last-good data when a record loses its identity", async () => {
    await seedNdw("2026-09-12T07:14:00.000Z");
    const before = await ndwRows();
    const anonymous = ndwXml.replace(' id="NLRWS_0005382945_1" version="536"', ' version="536"');
    const failed = await runSource(ndwFeed, {
      sql,
      fetch: serveXml(anonymous),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(failed.error).toBeDefined();
    expect(await ndwRows()).toEqual(before);
  }, 120_000);

  it("keeps an unchanged restriction fresh across a 304 response", async () => {
    await seedNdw("2026-09-12T07:14:00.000Z");
    const before = await ndwRows();
    const unchanged = await runSource(ndwFeed, {
      sql,
      fetch: serveXml("", 304),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(unchanged.error).toBeUndefined();
    expect(await ndwRows()).toEqual(before);
  }, 120_000);

  it("lets a healthy source publish while NDW fails", async () => {
    const healthy = await runSource(feed, {
      sql,
      fetch: serve(roadworks()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    const broken = await runSource(ndwFeed, {
      sql,
      fetch: serveXml("<mc:messageContainer>"),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:14:00.000Z",
    });
    expect(healthy.error).toBeUndefined();
    expect(broken.error).toBeDefined();
    expect(await idsAndHashes()).toHaveLength(5);
    expect(await ndwRows()).toHaveLength(0);
  }, 120_000);
});
