import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { LookupFn } from "@openconditions/ingest-framework";
import { runSource, type DomainFeedSource } from "../pipeline/run.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * Complete-snapshot acceptance against a real disposable PostGIS. The point of
 * these cases is the difference between "the publisher withdrew this record"
 * and "we failed to read this record": only the former may delete a row.
 */

const FIXTURE_URL = new URL(
  "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
  import.meta.url
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
const feed: DomainFeedSource = {
  id: "fi-digitraffic",
  domain: "roads",
  operator: "digitraffic",
  name: "Digitraffic (Finland)",
  format: "digitraffic",
  url: [ANNOUNCEMENTS, ROADWORKS, WEIGHTS, EXEMPTED],
  requestHeaders: { "Digitraffic-User": "OpenConditions/1.0", "Accept-Encoding": "gzip" },
  snapshot: { completeness: "complete", recordsPath: "features" },
  cadenceSec: 120,
  freshnessWindowSec: 600,
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
} as unknown as DomainFeedSource;

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
  await sql`DELETE FROM conditions.observations WHERE source = 'fi-digitraffic'`;
  await sql`DELETE FROM conditions.source_status WHERE source = 'fi-digitraffic'`;
});

async function idsAndHashes(): Promise<Array<{ id: string; content_hash: string | null }>> {
  return sql<Array<{ id: string; content_hash: string | null }>>`
    SELECT id, content_hash FROM conditions.observations
    WHERE source = 'fi-digitraffic' ORDER BY id`;
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
      "fi-digitraffic:GUID50461965",
      "fi-digitraffic:GUID50465935",
      "fi-digitraffic:GUID50466626",
      "fi-digitraffic:GUID50468844",
      "fi-digitraffic:GUID50470575",
    ]);
    const stored = await sql<Array<{ attributes: Record<string, unknown> }>>`
      SELECT attributes FROM conditions.observations
      WHERE id = 'fi-digitraffic:GUID50465935'`;
    const details = stored[0]!.attributes["restrictionDetails"] as {
      facts: Array<{ value: number; unit: string }>;
    };
    expect(details.facts[0]).toMatchObject({ value: 26000, unit: "kg" });
  }, 120_000);

  it("rejects a candidate in which a still-published record lost its geometry", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();
    expect(before).toHaveLength(5);
    const status = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic'`;

    const lostGeometry = roadworks();
    // Keep the id, remove only its geometry: the publisher still serves it.
    lostGeometry.features = lostGeometry.features.map((feature) =>
      (feature["properties"] as Record<string, unknown>)["situationId"] === "GUID50465935"
        ? { ...feature, geometry: null }
        : feature
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
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic'`;
    expect(after[0]!.last_success_at?.toISOString()).toBe(
      status[0]!.last_success_at?.toISOString()
    );
  }, 120_000);

  it("withdraws a record only when it is absent from an accepted snapshot", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const removed = roadworks();
    removed.features = removed.features.filter(
      (feature) =>
        (feature["properties"] as Record<string, unknown>)["situationId"] !== "GUID50465935"
    );
    const result = await runSource(feed, {
      sql,
      fetch: serve(removed),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:16:00.000Z",
    });
    expect(result.error).toBeUndefined();
    expect((await idsAndHashes()).map((r) => r.id)).not.toContain("fi-digitraffic:GUID50465935");
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
      ).error
    ).toBeDefined();
    expect(await idsAndHashes()).toEqual(before);

    const malformed = roadworks();
    malformed.features = malformed.features.map((feature, index) =>
      index === 0
        ? { ...feature, properties: { ...(feature["properties"] as object), situationId: null } }
        : feature
    );
    expect(
      (
        await runSource(feed, {
          sql,
          fetch: serve(malformed),
          lookup: fakeLookup,
          now: () => "2026-09-12T07:17:00.000Z",
        })
      ).error
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
        : feature
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
    expect(rows.map((r) => r.id)).not.toContain("fi-digitraffic:GUID50466626");
  }, 120_000);

  it("advances checked time on an unchanged snapshot without changing content", async () => {
    await seed("2026-09-12T07:14:00.000Z");
    const before = await idsAndHashes();
    const beforeQueue = await sql<Array<{ observation_id: string }>>`
      SELECT observation_id FROM conditions.binding_queue ORDER BY observation_id`;

    const again = await runSource(feed, {
      sql,
      fetch: serve(roadworks()),
      lookup: fakeLookup,
      now: () => "2026-09-12T07:20:00.000Z",
    });
    expect(again.error).toBeUndefined();
    expect(again.count).toBe(0);
    expect(await idsAndHashes()).toEqual(before);
    const afterQueue = await sql<Array<{ observation_id: string }>>`
      SELECT observation_id FROM conditions.binding_queue ORDER BY observation_id`;
    expect(afterQueue.map((r) => r.observation_id)).toEqual(
      beforeQueue.map((r) => r.observation_id)
    );
    const status = await sql<Array<{ last_success_at: Date | null }>>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'fi-digitraffic'`;
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
    const id = "fi-digitraffic:GUID50465935";
    expect(after.find((r) => r.id === id)!.content_hash).not.toBe(
      before.find((r) => r.id === id)!.content_hash
    );
    const queued = await sql<Array<{ observation_id: string }>>`
      SELECT observation_id FROM conditions.binding_queue WHERE observation_id = ${id}`;
    expect(queued).toHaveLength(1);
  }, 120_000);
});
