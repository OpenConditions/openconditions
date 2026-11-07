import { readFileSync } from "node:fs";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { JMA_DAILY_BYTES, JmaAcquisition } from "../jma-acquisition.js";
import { jmaDownloadStore } from "../jma-download-store.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});
const url = "https://www.data.jma.go.jp/developer/xml/data/20261106104333_0_VXSE52_010000.xml";
const body = readFileSync(
  new URL(
    "../../../../../packages/hazards/src/__tests__/fixtures/jma/33_12_01_240613_VXSE52.xml",
    import.meta.url,
  ),
);
const at = () => Date.parse("2026-11-07T01:00:00Z");
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const signal = () => AbortSignal.timeout(10_000);

test("persisted bytes prevent repeated message downloads across acquisition instances", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(body));
  const first = new JmaAcquisition(jmaDownloadStore(db.sql), "test-egress", at, transport, lookup);
  expect(await first.read(url, signal())).toEqual(body);
  const restarted = new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "test-egress",
    at,
    transport,
    lookup,
  );
  expect(await restarted.read(url, signal())).toEqual(body);
  expect(transport).toHaveBeenCalledTimes(1);
  const [budget] =
    await db.sql`SELECT used, reserved FROM conditions.jma_budget WHERE egress = 'test-egress'`;
  expect(Number(budget!.used)).toBe(body.length);
  expect(Number(budget!.reserved)).toBe(0);
});

test("both source channels share an atomic budget; reservations are not reported as bytes", async () => {
  const store = jmaDownloadStore(db.sql);
  await store.reserve("budget-test", "2026-11-07", JMA_DAILY_BYTES - 10);
  const results = await Promise.allSettled([
    store.reserve("budget-test", "2026-11-07", 10),
    store.reserve("budget-test", "2026-11-07", 10),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const [row] =
    await db.sql`SELECT used, reserved FROM conditions.jma_budget WHERE egress = 'budget-test'`;
  expect(Number(row!.used)).toBe(0);
  expect(Number(row!.reserved)).toBe(JMA_DAILY_BYTES);
});

test("conditional indexes persist their validators; long indexes keep hourly cadence", async () => {
  const index = "https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml";
  const xml =
    '<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-07T01:00:00Z</updated></feed>';
  let now = at();
  const transport = vi.fn<typeof fetch>(async (_input, init) => {
    if (new Headers(init?.headers).get("if-none-match") === '"jma"')
      return new Response(null, { status: 304 });
    return new Response(xml, { headers: { etag: '"jma"' } });
  });
  const acquisition = () =>
    new JmaAcquisition(jmaDownloadStore(db.sql), "conditional", () => now, transport, lookup);
  await acquisition().read(index, signal());
  now += 60_000;
  await acquisition().read(index, signal());
  expect(transport).toHaveBeenCalledTimes(1);
  now += 3_600_000;
  expect((await acquisition().read(index, signal())).toString()).toBe(xml);
  expect(transport).toHaveBeenCalledTimes(2);
});

test("rejects hostile paths and redirects without reaching the target", async () => {
  const transport = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
  );
  const acquisition = new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "hostile",
    at,
    transport,
    lookup,
  );
  await expect(
    acquisition.read("https://www.data.jma.go.jp/developer/xml/data/../private", signal()),
  ).rejects.toThrow("untrusted");
  expect(transport).not.toHaveBeenCalled();
  await expect(
    acquisition.read("https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml", signal()),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});

import { readJmaReport } from "@openconditions/hazards";
import { reconcileJmaIn } from "../jma-state-store.js";

test("lifecycle state, tombstones and cursors roll back with the publication callback", async () => {
  const report = { ...readJmaReport(body, "VXSE52"), controlAt: "2026-11-07T00:59:00Z" };
  await reconcileJmaIn(db.sql, "state-test", [report], at(), false, async () => {});
  const [before] = await db.sql`SELECT value FROM conditions.jma_state WHERE source = 'state-test'`;
  await expect(
    reconcileJmaIn(
      db.sql,
      "state-test",
      [{ ...report, cancelled: true, controlAt: "2026-11-07T01:00:00Z" }],
      at() + 60_000,
      true,
      async (tx) => {
        await tx`INSERT INTO conditions.jma_download (url, value) VALUES ('rollback-marker', '{}'::jsonb)`;
        throw new Error("canonical publication failed");
      },
    ),
  ).rejects.toThrow("canonical publication failed");
  const [after] = await db.sql`SELECT value FROM conditions.jma_state WHERE source = 'state-test'`;
  expect(after!.value).toEqual(before!.value);
  expect(
    await db.sql`SELECT url FROM conditions.jma_download WHERE url = 'rollback-marker'`,
  ).toHaveLength(0);
  await reconcileJmaIn(
    db.sql,
    "state-test",
    [{ ...report, cancelled: true, controlAt: "2026-11-07T01:00:00Z" }],
    at() + 60_000,
    false,
    async () => {},
  );
  await reconcileJmaIn(
    db.sql,
    "state-test",
    [report],
    at() + 120_000,
    false,
    async (_tx, state) => {
      expect(Object.values(state.native.products)[0]!.cancelled).toBe(true);
      expect(state.coverage).toBe("incomplete");
    },
  );
});

test("cold recovery reads both windows and filters families before payload requests", async () => {
  const irrelevant =
    "https://www.data.jma.go.jp/developer/xml/data/20261106104333_0_VXSE60_010000.xml";
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-07T01:00:00Z</updated><entry><id>${url}</id><link href="${url}"/></entry><entry><id>${irrelevant}</id><link href="${irrelevant}"/></entry></feed>`;
  const transport = vi.fn<typeof fetch>(async () => new Response(xml));
  const acquisition = new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "recovery",
    at,
    transport,
    lookup,
  );
  // The payload from the earlier test is durably cached, so only indexes are requested.
  const result = await acquisition.poll("eqvol", ["VXSE52"], undefined, signal());
  expect(result.gap).toBe(true);
  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]!.report.earthquake?.magnitude).toBeUndefined();
  expect(transport.mock.calls.map((c) => String(c[0]))).toEqual([
    "https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml",
    "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
  ]);
});

test("uncertain transport failures keep reservations separate from received bytes", async () => {
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("connection lost");
  });
  const acquisition = new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "uncertain",
    at,
    transport,
    lookup,
  );
  await expect(
    acquisition.read("https://www.data.jma.go.jp/developer/xml/feed/extra.xml", signal()),
  ).rejects.toThrow("connection lost");
  const [row] =
    await db.sql`SELECT used, reserved FROM conditions.jma_budget WHERE egress = 'uncertain'`;
  expect(Number(row!.used)).toBe(0);
  expect(Number(row!.reserved)).toBe(8_000_000);
});

test("transient retry charges uncertain first attempt and only received bytes on success", async () => {
  let calls = 0;
  const transport = vi.fn<typeof fetch>(async () => {
    if (++calls === 1) throw new TypeError("network unavailable");
    return new Response(body);
  });
  const freshUrl = url.replace("20261106104333", "20261106104334");
  await new JmaAcquisition(jmaDownloadStore(db.sql), "retry-test", at, transport, lookup).read(
    freshUrl,
    signal(),
  );
  expect(calls).toBe(2);
  const [budget] =
    await db.sql`SELECT used,reserved FROM conditions.jma_budget WHERE egress='retry-test'`;
  expect(Number(budget!.reserved)).toBe(8_000_000);
  expect(Number(budget!.used)).toBe(body.length);
});

test("quake retention floor prevents replay after tombstone cleanup", async () => {
  const report = { ...readJmaReport(body, "VXSE52"), controlAt: "2026-11-07T00:00:00Z" };
  await reconcileJmaIn(db.sql, "retention-test", [report], at(), false, async () => {});
  await reconcileJmaIn(
    db.sql,
    "retention-test",
    [{ ...report, cancelled: true, controlAt: "2026-11-07T01:00:00Z" }],
    at() + 1,
    false,
    async () => {},
  );
  await reconcileJmaIn(
    db.sql,
    "retention-test",
    [report],
    at() + 31 * 86_400_000,
    false,
    async (_tx, state) => {
      expect(state.native.products).toEqual({});
    },
  );
});

test("cache-only index polls do not validate the network or change payload acquisition time", async () => {
  const index = `https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml`;
  await db.sql`DELETE FROM conditions.jma_download WHERE url=${index}`;
  let now = at();
  const transport = (async () =>
    new Response(
      `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-07T01:00:00Z</updated><entry><id>${url}</id><link href="${url}"/></entry></feed>`,
    )) as typeof fetch;
  const first = await new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "freshness",
    () => now,
    transport,
    lookup,
  ).poll("eqvol", ["VXSE52"], now, signal());
  expect(first.networkValidated).toBe(true);
  expect(first.reports[0]!.report.acquiredAt).toBe("2026-11-07T01:00:00.000Z");
  now += 1000;
  const cached = await new JmaAcquisition(
    jmaDownloadStore(db.sql),
    "freshness",
    () => now,
    transport,
    lookup,
  ).poll("eqvol", ["VXSE52"], now, signal());
  expect(cached.networkValidated).toBe(false);
  expect(cached.reports[0]!.report.acquiredAt).toBe(first.reports[0]!.report.acquiredAt);
});

test("concurrent source commits serialize and stale polls cannot replace a newer revision", async () => {
  const report = { ...readJmaReport(body, "VXSE52"), controlAt: "2026-11-07T00:59:00Z" };
  let release!: () => void;
  let entered!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const newer = reconcileJmaIn(db.sql, "concurrent-state", [report], at() + 1, false, async () => {
    entered();
    await hold;
  });
  await locked;
  const stale = reconcileJmaIn(db.sql, "concurrent-state", [report], at(), true, async () => {
    throw new Error("stale callback reached");
  });
  const rejected = expect(stale).rejects.toThrow("stale poll");
  release();
  await newer;
  await rejected;
  const [state] =
    await db.sql`SELECT value FROM conditions.jma_state WHERE source='concurrent-state'`;
  expect(state!.value.lastSuccess).toBe(at() + 1);
  expect(state!.value.gap).toBe(false);
});

test("lifecycle area bound refuses publication and initialization atomically", async () => {
  const original = readJmaReport(
    readFileSync(
      new URL(
        "../../../../../packages/hazards/src/__tests__/fixtures/jma/VPWW55_JPTF_170922.xml",
        import.meta.url,
      ),
    ),
    "VPWW55",
  );
  const report = {
    ...original,
    warnings: Array.from({ length: 20001 }, (_, i) => ({
      ...original.warnings[0]!,
      area: String(i),
    })),
  };
  const publish = vi.fn(async () => {});
  await expect(
    reconcileJmaIn(db.sql, "area-bound", [report], at(), true, publish, {
      source: "area-bound",
      at: new Date(at()).toISOString(),
      coverage: "incomplete",
      method: "rolling-index-observed-reports",
      payloadHashes: [],
    }),
  ).rejects.toThrow("state bound");
  expect(publish).not.toHaveBeenCalled();
  expect(
    await db.sql`SELECT value FROM conditions.jma_state WHERE source='area-bound'`,
  ).toHaveLength(0);
});

test.each(["2026-11-06T00:00:00Z", "2026-11-08T00:00:00Z"])(
  "aged or future index %s cannot start payload downloads",
  async (updated) => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<feed xmlns="http://www.w3.org/2005/Atom"><updated>${updated}</updated><entry><id>${url}</id><link href="${url}"/></entry></feed>`,
        ),
    );
    const acquisition = new JmaAcquisition(
      jmaDownloadStore(db.sql),
      "aged-index",
      at,
      transport,
      lookup,
    );
    // Advance the fixed clock past any index cached by another test.
    await db.sql`DELETE FROM conditions.jma_download WHERE url LIKE '%/feed/%'`;
    await expect(acquisition.poll("eqvol", ["VXSE52"], at(), signal())).rejects.toThrow("index");
    expect(transport.mock.calls.every(([u]) => !String(u).includes("/data/"))).toBe(true);
  },
);
