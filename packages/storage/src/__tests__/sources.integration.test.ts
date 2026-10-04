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

const RIGHTS = {
  redistribution: true,
  derivedRedistribution: true,
  commercialUse: true,
  attributionRequired: false,
  retention: true,
  shareAlike: false,
};
const ndw: SourceEntry = {
  id: "nl-ndw-events",
  domain: "roads",
  format: "datex2",
  product: "events",
  tier: "authoritative",
  country: "NL",
  operator: "ndw",
  license: "CC0-1.0",
  attribution: "NDW / Rijkswaterstaat",
  rights: RIGHTS,
  restricted: false,
  cadenceSec: 60,
  freshnessWindowSec: 300,
  laneNumbering: "left_first",
};
const longdo: SourceEntry = {
  id: "th-longdo-events",
  domain: "roads",
  format: "flatjson",
  product: "events",
  tier: "aggregator",
  country: "TH",
  operator: "longdo",
  license: "CC-BY-4.0",
  attribution: "Longdo",
  restricted: false,
  cadenceSec: 300,
  freshnessWindowSec: 900,
  extrasAllow: ["category"],
};

describe("syncSources", () => {
  it("mirrors the loaded catalogue, with defaults for omitted fields", async () => {
    await syncSources(sql, [ndw, longdo]);
    const rows = await sql`
      SELECT id, tier, access_mode, product, lane_numbering, extras_allow, extras_federate,
        rights, active FROM conditions.source ORDER BY id`;
    expect(rows).toEqual([
      {
        id: "nl-ndw-events",
        tier: "authoritative",
        access_mode: "bulk",
        product: "events",
        lane_numbering: "left_first",
        extras_allow: [],
        extras_federate: false,
        rights: RIGHTS,
        active: true,
      },
      {
        id: "th-longdo-events",
        tier: "aggregator",
        access_mode: "bulk",
        product: "events",
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
      { id: "nl-ndw-events", tier: "operator", active: true },
      { id: "th-longdo-events", tier: "aggregator", active: false },
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

  it("syncSources stores whether a source is restricted", async () => {
    await syncSources(sql, [ndw, { ...longdo, license: "NOASSERTION", restricted: true }]);
    const rows = await sql`SELECT id, restricted FROM conditions.source ORDER BY id`;
    expect(rows).toEqual([
      { id: "nl-ndw-events", restricted: false },
      { id: "th-longdo-events", restricted: true },
    ]);
    await syncSources(sql, [ndw, longdo]);
    const [row] = await sql`SELECT restricted FROM conditions.source WHERE id = ${longdo.id}`;
    expect(row).toEqual({ restricted: false });
  });

  it("leaves the basis a source's fusions were refreshed under alone", async () => {
    await syncSources(sql, [ndw, longdo]);
    await sql`
      UPDATE conditions.source SET fusion_restricted = false, fusion_tier = 'authoritative'
       WHERE id = ${ndw.id}`;
    const fresh = { ...ndw, id: "nl-ndw-flow", product: "flow" };
    await syncSources(sql, [{ ...ndw, restricted: true, tier: "operator" }, longdo, fresh]);
    const rows = await sql`
      SELECT id, restricted, tier, fusion_restricted, fusion_tier FROM conditions.source
       WHERE id IN (${ndw.id}, ${fresh.id}) ORDER BY id`;
    expect(rows).toEqual([
      {
        id: ndw.id,
        restricted: true,
        tier: "operator",
        fusion_restricted: false,
        fusion_tier: "authoritative",
      },
      {
        id: fresh.id,
        restricted: false,
        tier: "authoritative",
        fusion_restricted: null,
        fusion_tier: null,
      },
    ]);
  });

  it("stores a source of no single country with no country", async () => {
    const { country: _country, ...noCountry } = longdo;
    await syncSources(sql, [ndw, longdo, { ...noCountry, id: "test-flow", product: "flow" }]);
    const [row] = await sql`SELECT product, country FROM conditions.source WHERE id = 'test-flow'`;
    expect(row).toEqual({ product: "flow", country: null });
  });
});
