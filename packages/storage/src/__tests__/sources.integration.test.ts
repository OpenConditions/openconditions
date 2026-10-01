import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SourceEntry, syncSources } from "../sources.js";
import { createTestDatabase } from "./database.integration.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const ndw: SourceEntry = {
  id: "nl-ndw",
  domain: "roads",
  format: "datex2",
  tier: "authoritative",
  country: "NL",
  operator: "ndw",
  license: "CC0-1.0",
  attribution: "NDW / Rijkswaterstaat",
  rights: { retention: true },
  cadenceSec: 60,
  freshnessWindowSec: 300,
  laneNumbering: "left_first",
};
const longdo: SourceEntry = {
  id: "th-longdo",
  domain: "roads",
  format: "flatjson",
  tier: "aggregator",
  country: "TH",
  operator: "longdo",
  license: "CC-BY-4.0",
  attribution: "Longdo",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  extrasAllow: ["category"],
};

describe("syncSources", () => {
  it("mirrors the loaded catalogue, with defaults for omitted fields", async () => {
    await syncSources(sql, [ndw, longdo]);
    const rows = await sql`
      SELECT id, tier, access_mode, produces, lane_numbering, extras_allow, extras_federate,
        rights, active FROM conditions.source ORDER BY id`;
    expect(rows).toEqual([
      {
        id: "nl-ndw",
        tier: "authoritative",
        access_mode: "bulk",
        produces: "events",
        lane_numbering: "left_first",
        extras_allow: [],
        extras_federate: false,
        rights: { retention: true },
        active: true,
      },
      {
        id: "th-longdo",
        tier: "aggregator",
        access_mode: "bulk",
        produces: "events",
        lane_numbering: null,
        extras_allow: ["category"],
        extras_federate: false,
        rights: null,
        active: true,
      },
    ]);
  });

  it("refreshes a changed source and keeps a dropped one, inactive", async () => {
    await syncSources(sql, [{ ...ndw, tier: "operator" }]);
    const rows = await sql`SELECT id, tier, active FROM conditions.source ORDER BY id`;
    expect(rows).toEqual([
      { id: "nl-ndw", tier: "operator", active: true },
      { id: "th-longdo", tier: "aggregator", active: false },
    ]);
  });

  it("reactivates a source that is loaded again", async () => {
    await syncSources(sql, [ndw, longdo]);
    const rows = await sql`SELECT id, active FROM conditions.source ORDER BY id`;
    expect(rows.map((r) => r["active"])).toEqual([true, true]);
  });

  it("refuses a tier the kernel does not know", async () => {
    await expect(syncSources(sql, [{ ...ndw, tier: "official" }])).rejects.toThrow(
      /source_tier_enum/,
    );
  });
});
