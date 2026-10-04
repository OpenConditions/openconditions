import { cellsCovering } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { describe, expect, test, vi } from "vitest";
import { readThrough } from "../on-demand/read-through.js";
import { fakeLookup, onDemandFeed, registry, START, upstream } from "./helpers/on-demand.js";

vi.mock("@openconditions/ingest-framework", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openconditions/ingest-framework")>();
  return { ...original, cellsCovering: vi.fn(original.cellsCovering) };
});

vi.mock("../domains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domains.js")>();
  const { testDomain: domain } = await import("./helpers/on-demand.js");
  const isTest = (feed: { domain: string }) => feed.domain === "fuel";
  return {
    ...original,
    domainOf: (feed: Parameters<typeof original.domainOf>[0]) =>
      isTest(feed) ? domain : original.domainOf(feed),
    formatOf: (feed: Parameters<typeof original.formatOf>[0]) =>
      isTest(feed) ? domain.formats[feed.format]! : original.formatOf(feed),
  };
});

const WORLD: [number, number, number, number] = [-180, -90, 180, 90];

/** A database that records every query and answers none. */
function noDatabase() {
  const queries: unknown[] = [];
  const refuse = (...args: unknown[]) => {
    queries.push(args);
    throw new Error("no database in this test");
  };
  const sql = Object.assign(refuse, { unsafe: refuse, begin: refuse }) as unknown as postgres.Sql;
  return { sql, queries };
}

describe("on-demand read-through limits", () => {
  test("a world read of a world-wide source is refused before any cell is built or the ledger read", async () => {
    // Shaped like the OSM fuel source: world coverage on a 0.1° grid, 16 cells a read.
    const feed = onDemandFeed("world", {
      onDemand: { cellDeg: 0.1, ttlSec: 3600, maxCellsPerRead: 16, probe: [8.4, 49.01] },
      coverage: { bbox: WORLD },
    });
    const { sql, queries } = noDatabase();
    const up = upstream();
    const started = performance.now();
    const coverage = await readThrough(
      sql,
      { feeds: [feed] },
      { bbox: WORLD, class: "feature", kinds: ["fuel_station"], scope: "operator" },
      {
        fetch: up.fetch,
        now: () => START,
        deadlineMs: 3000,
        registry,
        instanceId: "test.local",
        lookup: fakeLookup,
      },
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(coverage).toEqual({
      partial: true,
      sources: [{ id: feed.id, complete: false, reason: "too_many_cells" }],
    });
    expect(cellsCovering).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
    expect(up.calls).toEqual([]);
  });

  test("a public read never fetches a restricted source, even one it names", async () => {
    const feed = { ...onDemandFeed("closed"), restricted: true };
    const { sql, queries } = noDatabase();
    const up = upstream();
    const coverage = await readThrough(
      sql,
      { feeds: [feed] },
      {
        bbox: [8, 49, 8.1, 49.1],
        class: "feature",
        kinds: ["fuel_station"],
        sources: [feed.id],
        scope: "public",
      },
      {
        fetch: up.fetch,
        now: () => START,
        deadlineMs: 3000,
        registry,
        instanceId: "test.local",
        lookup: fakeLookup,
      },
    );
    expect(coverage).toBeUndefined();
    expect(queries).toEqual([]);
    expect(up.calls).toEqual([]);
  });

  test("an offer read fetches only the sources that produce offers of what it asks for", async () => {
    // The test format produces fuel stations (domain fuel) and energy tariffs (domain charging).
    const feed = onDemandFeed("offers");
    const read = (q: { domain?: string; kinds?: string[] }) => {
      const { sql, queries } = noDatabase();
      const up = upstream();
      const coverage = readThrough(
        sql,
        { feeds: [feed] },
        { bbox: [8, 49, 8.1, 49.1], class: "offer", scope: "public", ...q },
        {
          fetch: up.fetch,
          now: () => START,
          deadlineMs: 3000,
          registry,
          instanceId: "test.local",
          lookup: fakeLookup,
        },
      );
      return { coverage, queries, up };
    };

    for (const q of [{ domain: "fuel" }, { kinds: ["fuel_station"] }]) {
      const { coverage, queries, up } = read(q);
      expect(await coverage, JSON.stringify(q)).toBeUndefined();
      expect(queries).toEqual([]);
      expect(up.calls).toEqual([]);
    }
    // An offer kind it produces does take part (the stub database refuses the ledger read).
    for (const q of [{ domain: "charging" }, { kinds: ["energy_tariff"] }]) {
      const { coverage } = read(q);
      expect(await coverage, JSON.stringify(q)).toEqual({
        partial: true,
        sources: [{ id: feed.id, complete: false, reason: "failed" }],
      });
    }
  });
});
