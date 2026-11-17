import { isPeerBlocked } from "@openconditions/federation";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminDeps, runAdminCommand } from "../ops/admin.js";
import { OWN_INSTANCE, ownSituation, situationId, storeSituation } from "./record-fixtures.js";

let db: TestDatabase;
let sql: postgres.Sql;

const NOW = "2026-11-17T12:00:00.000Z";

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 3 } });
  sql = db.sql;
  await syncSources(sql, [
    {
      id: "nl-ndw-events",
      domain: "roads",
      format: "datex2",
      product: "events",
      tier: "authoritative",
      country: "NL",
      operator: "NDW",
      license: "CC0-1.0",
      attribution: "NDW",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 600,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

/** Runs a command, returning its exit code and what it printed. */
async function run(...args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const deps: AdminDeps = {
    sql,
    registry: productionRegistry(),
    instanceId: OWN_INSTANCE,
    operator: "ops@example.org",
    now: () => NOW,
    out: (line) => lines.push(line),
  };
  return { code: await runAdminCommand(args, deps), lines };
}

describe("the federation admin command", () => {
  it("blocks, lists and unblocks a peer", async () => {
    expect(await run("blocked")).toEqual({ code: 0, lines: ["no peer is blocked"] });
    expect(await run("block", "bad.example.net", "--reason", "spam")).toEqual({
      code: 0,
      lines: ["blocked bad.example.net: spam"],
    });
    expect(await isPeerBlocked(sql, "bad.example.net")).toBe(true);
    expect(await run("blocked")).toEqual({
      code: 0,
      lines: [`blocked: bad.example.net (since ${NOW} by ops@example.org: spam)`],
    });
    expect(await run("unblock", "bad.example.net")).toEqual({
      code: 0,
      lines: ["unblocked bad.example.net"],
    });
    expect(await isPeerBlocked(sql, "bad.example.net")).toBe(false);
    expect(await run("unblock", "bad.example.net")).toEqual({
      code: 0,
      lines: ["bad.example.net was not blocked"],
    });
  });

  it("erases a record held here once, and says when there is none", async () => {
    await storeSituation(sql, ownSituation("admin-erase"));
    const id = situationId("admin-erase");
    expect(await run("erase", "situation", id)).toEqual({ code: 0, lines: ["erased"] });
    const [row] = await sql<{ tombstone_reason: string | null }[]>`
      SELECT tombstone_reason FROM conditions.situation WHERE id = ${id}`;
    expect(row?.tombstone_reason).toBe("rights_revoked");
    expect(await run("erase", "situation", id)).toEqual({ code: 0, lines: ["already erased"] });
    expect(await run("erase", "offer", "oc:offer:none:missing")).toEqual({
      code: 1,
      lines: ["not found"],
    });
  });

  it("makes a comparison with a peer due, or says the peer was never pulled", async () => {
    expect((await run("reconcile", "never.example.net")).code).toBe(1);
    await sql`
      INSERT INTO conditions.federation_peer_cursor (peer_instance_id, cursor, updated_at)
      VALUES ('pulled.example.net', '7.1', now())`;
    const done = await run("reconcile", "pulled.example.net");
    expect(done.code).toBe(0);
    expect(done.lines).toHaveLength(1);
    const [row] = await sql<{ due: Date | null; cls: string | null }[]>`
      SELECT reconcile_due_since AS due, reconcile_class AS cls
        FROM conditions.federation_peer_cursor WHERE peer_instance_id = 'pulled.example.net'`;
    expect(row?.due?.toISOString()).toBe(NOW);
    expect(row?.cls).toBeNull();
  });

  it("prints the usage and exits 2 on bad usage", async () => {
    for (const args of [
      [],
      ["unknown"],
      ["block"],
      ["block", "peer", "--reason"],
      ["block", "peer", "--why", "x"],
      ["erase", "observation", "x"],
      ["erase", "situation"],
      ["reconcile"],
      ["blocked", "extra"],
    ]) {
      const { code, lines } = await run(...args);
      expect(code).toBe(2);
      expect(lines[0]).toMatch(/^usage: federation-admin/);
    }
  });
});
