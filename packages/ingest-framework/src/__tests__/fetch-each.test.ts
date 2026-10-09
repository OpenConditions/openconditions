import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointSchema } from "../catalog/schema.js";
import type { CatalogFeed } from "../catalog/types.js";
import { createFetchState, fetchEndpoint, type KeptItems } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const SITES = Buffer.from(JSON.stringify({ features: [{ id: "C1" }, { id: "C 2" }] }));

const EACH = { role: "sites", records: "features", field: "id" };

function feedWith(over: Partial<CatalogFeed> = {}, each = EACH): CatalogFeed {
  return catalogFeed({
    endpoints: {
      sites: { url: "https://api.test/sites", cadenceSec: 3600 },
      details: { url: "https://api.test/stations/{item}", cadenceSec: 86400, each },
    },
    ...over,
  });
}

/** An upstream recording each request's URL and start time; `failing` URLs answer 500. */
function upstream(failing: string[] = []) {
  const calls: { url: string; at: number; headers: Headers }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), headers: new Headers(init?.headers) });
    if (failing.includes(url)) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { etag: `"${url}"` },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("fetchEndpoint each", () => {
  it("fetches once per id of its source role, in order, with the id encoded", async () => {
    const up = upstream();
    const res = await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [SITES],
    });

    expect(up.calls.map((c) => c.url)).toEqual([
      "https://api.test/stations/C1",
      "https://api.test/stations/C%202",
    ]);
    if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
    expect(res.buffers.map((b) => JSON.parse(b.toString()).url)).toEqual(
      up.calls.map((c) => c.url),
    );
    expect(res.payloads).toHaveLength(2);
  });

  it("reads the ids of every source payload and skips records without one", async () => {
    const up = upstream();
    const second = Buffer.from(JSON.stringify({ features: [{ id: 7 }, {}, { id: "C1" }] }));
    await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [SITES, second],
    });
    expect(up.calls.map((c) => c.url)).toEqual([
      "https://api.test/stations/C1",
      "https://api.test/stations/C%202",
      "https://api.test/stations/7",
    ]);
  });

  it("reads a nested id field with getPath", async () => {
    const up = upstream();
    const nested = Buffer.from(JSON.stringify({ data: { list: [{ props: { id: "A" } }] } }));
    await fetchEndpoint(
      feedWith({}, { role: "sites", records: "data.list", field: "props.id" }),
      "details",
      up.fn,
      { state: createFetchState(), eachSource: [nested] },
    );
    expect(up.calls.map((c) => c.url)).toEqual(["https://api.test/stations/A"]);
  });

  it("fails when the source payload is missing, not JSON, or has no records list", async () => {
    const up = upstream();
    const run = (eachSource?: Buffer[]) =>
      fetchEndpoint(feedWith(), "details", up.fn, {
        state: createFetchState(),
        ...(eachSource ? { eachSource } : {}),
      });
    await expect(run()).rejects.toThrow(/sites/);
    await expect(run([Buffer.from("<html>")])).rejects.toThrow(/not valid JSON/);
    await expect(run([Buffer.from("{}")])).rejects.toThrow(/features/);
    expect(up.calls).toHaveLength(0);
  });

  it("sends the feed's authorization and headers with every item request", async () => {
    const up = upstream();
    const feed = feedWith({
      auth: { kind: "header-key", header: "X-Api-Key", credential: "key" },
      credentials: { key: { title: "Key" } },
    });
    await fetchEndpoint(feed, "details", up.fn, {
      state: createFetchState(),
      env: { XX_TEST_EVENTS_KEY: "secret" },
      eachSource: [SITES],
    });
    expect(up.calls).toHaveLength(2);
    for (const call of up.calls) expect(call.headers.get("X-Api-Key")).toBe("secret");
  });

  it("never lets one item's validator apply to another, or to the next poll", async () => {
    const up = upstream();
    const state = createFetchState();
    for (let poll = 0; poll < 2; poll++) {
      await fetchEndpoint(feedWith(), "details", up.fn, { state, eachSource: [SITES] });
    }
    expect(up.calls.every((c) => !c.headers.has("If-None-Match"))).toBe(true);
  });

  it("an item that has no id left makes an empty fetch, not an invented request", async () => {
    const up = upstream();
    const res = await fetchEndpoint(feedWith(), "details", up.fn, {
      state: createFetchState(),
      eachSource: [Buffer.from(JSON.stringify({ features: [] }))],
    });
    expect(up.calls).toHaveLength(0);
    expect(res.status === "fetched" && res.buffers).toEqual([]);
  });

  describe("failures", () => {
    it("a failing item fails the role", async () => {
      const up = upstream(["https://api.test/stations/C1"]);
      await expect(
        fetchEndpoint(feedWith(), "details", up.fn, {
          state: createFetchState(),
          eachSource: [SITES],
        }),
      ).rejects.toThrow(/HTTP 500/);
    });

    it("a failing item stops the requests not yet sent", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => ({ id: `S${i}` }));
      const many = Buffer.from(JSON.stringify({ features: ids }));
      const calls: string[] = [];
      const fn = (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/S0")) return new Response("boom", { status: 500 });
        // The others answer later, so the failure is known before any worker takes another id.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ url }));
      }) as unknown as typeof fetch;
      await expect(
        fetchEndpoint(feedWith(), "details", fn, {
          state: createFetchState(),
          eachSource: [many],
        }),
      ).rejects.toThrow(/HTTP 500/);
      // Let the requests already sent settle: none is followed by another.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toHaveLength(8);
      expect(calls[0]).toBe("https://api.test/stations/S0");
    });

    it("with fanout tolerant, a failing item leaves the rest and a partial result", async () => {
      const up = upstream(["https://api.test/stations/C1"]);
      const feed = catalogFeed({
        endpoints: {
          sites: { url: "https://api.test/sites", cadenceSec: 3600 },
          details: {
            url: "https://api.test/stations/{item}",
            cadenceSec: 86400,
            each: EACH,
            fanout: "tolerant",
          },
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await fetchEndpoint(feed, "details", up.fn, {
          state: createFetchState(),
          eachSource: [SITES],
        });
        expect(res.status).toBe("partial");
        if (res.status !== "partial") return;
        expect(res.buffers).toHaveLength(1);
        expect(res.partitions).toEqual({ succeeded: 1, failed: 1, total: 2 });
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("pacing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("paces item requests with the feed's perMinute, shared with its other roles", async () => {
      const up = upstream();
      const feed = feedWith({ requestLimits: { perMinute: 2 } });
      const state = createFetchState();
      const begun = Date.now();
      const pending = Promise.all([
        fetchEndpoint(feed, "sites", up.fn, { state }),
        fetchEndpoint(feed, "details", up.fn, { state, eachSource: [SITES] }),
      ]);
      await vi.runAllTimersAsync();
      await pending;

      expect(up.calls).toHaveLength(3);
      expect(up.calls[2]!.at - begun).toBeGreaterThanOrEqual(60_000);
      expect(up.calls[1]!.at - begun).toBeLessThan(60_000);
    });
  });
});

const NWS_PATTERN =
  "^https://api\\.weather\\.gov/zones/((?:forecast|county|fire|marine|offshore)/[A-Z0-9]+)$";

/** NWS-shaped alerts: each feature lists its zones as URLs. */
function alerts(...zones: unknown[][]): Buffer {
  return Buffer.from(
    JSON.stringify({ features: zones.map((affectedZones) => ({ properties: { affectedZones } })) }),
  );
}

function zonesFeed(each: Record<string, unknown> = {}): CatalogFeed {
  return catalogFeed({
    endpoints: {
      alerts: { url: "https://api.weather.gov/alerts/active", cadenceSec: 120 },
      zones: {
        url: "https://api.weather.gov/zones/{item}",
        cadenceSec: 120,
        each: {
          role: "alerts",
          records: "features",
          field: "properties.affectedZones",
          pattern: NWS_PATTERN,
          ...each,
        },
      },
    },
  });
}

const zone = (path: string) => `https://api.weather.gov/zones/${path}`;

describe("fetchEndpoint each over lists and patterns", () => {
  it("fetches every element of a list field once", async () => {
    const up = upstream();
    const feed = zonesFeed({ pattern: undefined });
    await fetchEndpoint(feed, "zones", up.fn, {
      state: createFetchState(),
      eachSource: [alerts(["A1", "A2"], ["A2", 7, null, "A3"])],
    });
    expect(up.calls.map((c) => c.url)).toEqual([zone("A1"), zone("A2"), zone("A3")]);
  });

  it("keeps only the values the pattern matches and takes its group", async () => {
    const up = upstream();
    await fetchEndpoint(zonesFeed(), "zones", up.fn, {
      state: createFetchState(),
      eachSource: [
        alerts(
          [zone("forecast/WYZ001"), zone("county/WYC001")],
          [zone("forecast/WYZ001"), "https://elsewhere.test/zones/forecast/X1", zone("lake/X2")],
        ),
      ],
    });
    expect(up.calls.map((c) => c.url)).toEqual([zone("forecast/WYZ001"), zone("county/WYC001")]);
  });

  it("refuses an item that leaves its path and substitutes the rest segment by segment", async () => {
    const up = upstream();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fetchEndpoint(zonesFeed({ pattern: undefined }), "zones", up.fn, {
        state: createFetchState(),
        eachSource: [alerts(["forecast/../x", "forecast/WYZ001", "a?b", "..", "c d/e"])],
      });
      expect(up.calls.map((c) => c.url)).toEqual([zone("forecast/WYZ001"), zone("c%20d/e")]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3 items refused/));
    } finally {
      warn.mockRestore();
    }
  });

  describe("keepSec", () => {
    const T = Date.parse("2026-10-08T12:00:00Z");

    it("keeps an item's payload for keepSec and drops it once no record names it", async () => {
      const up = upstream();
      const feed = zonesFeed({ keepSec: 60 });
      const two = alerts([zone("forecast/A1"), zone("forecast/A2")]);
      const poll = async (source: Buffer, at: number, kept?: KeptItems) => {
        const res = await fetchEndpoint(feed, "zones", up.fn, {
          state: createFetchState(),
          eachSource: [source],
          at,
          ...(kept ? { kept } : {}),
        });
        if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
        return res;
      };

      const first = await poll(two, T);
      expect(up.calls).toHaveLength(2);
      expect([...first.kept!.keys()]).toEqual([zone("forecast/A1"), zone("forecast/A2")]);

      up.calls.length = 0;
      const second = await poll(two, T + 59_000, first.kept);
      expect(up.calls).toHaveLength(0);
      expect(second.buffers.map((b) => JSON.parse(b.toString()).url)).toEqual([
        zone("forecast/A1"),
        zone("forecast/A2"),
      ]);
      // Only what this call fetched is digested.
      expect(second.payloads).toEqual([]);
      expect(second.urls).toEqual([zone("forecast/A1"), zone("forecast/A2")]);

      const third = await poll(alerts([zone("forecast/A2")]), T + 59_000, second.kept);
      expect(up.calls).toHaveLength(0);
      expect(third.buffers).toHaveLength(1);
      expect([...third.kept!.keys()]).toEqual([zone("forecast/A2")]);

      // Past keepSec the item is asked again, and a returning one is new.
      await poll(two, T + 61_000, third.kept);
      expect(up.calls.map((c) => c.url)).toEqual([zone("forecast/A1"), zone("forecast/A2")]);
    });

    it("without keepSec nothing is kept", async () => {
      const up = upstream();
      const res = await fetchEndpoint(zonesFeed(), "zones", up.fn, {
        state: createFetchState(),
        eachSource: [alerts([zone("forecast/A1")])],
      });
      if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
      expect(res.kept).toBeUndefined();
    });
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "eccc-datamart");
const listing = (file: string) => readFileSync(join(FIXTURES, file), "utf8");
const DAY = "https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/";
const OFFICE = `${DAY}CWTO/`;
const ECCC_LINKS = [
  'href="([A-Z]{4}/)"',
  'href="(\\d{2}/)"[^>]*>[^<]*</a>\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})',
  'href="([^"]+\\.cap)"',
];
const FILES_18 = [
  "T_WHCN13_C_CWTO_202610081811_2013383073.cap",
  "T_WHCN13_C_CWTO_202610081811_2451493062.cap",
];
const FILES_19 = [
  "T_WHCN13_C_CWTO_202610081936_2688257323.cap",
  "T_WHCN13_C_CWTO_202610081959_1129882422.cap",
];

function walkFeed(links = ECCC_LINKS): CatalogFeed {
  return catalogFeed({
    endpoints: {
      index: {
        urls: [
          "https://dd.weather.gc.ca/{utcDate-1}/WXO-DD/alerts/cap/{utcDate-1}/",
          "https://dd.weather.gc.ca/{utcDate}/WXO-DD/alerts/cap/{utcDate}/",
        ],
        fanout: "tolerant",
        cadenceSec: 120,
      },
      alerts: { url: "{item}", cadenceSec: 120, each: { role: "index", links } },
    },
  });
}

/** A Datamart tree served from a map of URL to body; anything else answers 404. */
function datamart(tree: Map<string, string>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = tree.get(url);
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function capturedTree(): Map<string, string> {
  const tree = new Map<string, string>([
    [DAY, listing("day.txt")],
    [OFFICE, listing("office.txt")],
    [`${OFFICE}18/`, listing("hour-18.txt")],
    [`${OFFICE}19/`, listing("hour-19.txt")],
  ]);
  for (const file of FILES_18) tree.set(`${OFFICE}18/${file}`, `<alert>${file}</alert>`);
  for (const file of FILES_19) tree.set(`${OFFICE}19/${file}`, `<alert>${file}</alert>`);
  return tree;
}

describe("fetchEndpoint each walking links", () => {
  const T = Date.parse("2026-10-08T20:05:00Z");

  const walk = async (
    tree: Map<string, string>,
    up: ReturnType<typeof datamart>,
    kept?: KeptItems,
    feed = walkFeed(),
  ) => {
    const res = await fetchEndpoint(feed, "alerts", up.fn, {
      state: createFetchState(),
      eachSource: [Buffer.from(tree.get(DAY)!)],
      eachSourceUrls: [DAY],
      at: T,
      ...(kept ? { kept } : {}),
    });
    if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
    return res;
  };

  it("lists every level and fetches the files below", async () => {
    const tree = capturedTree();
    const up = datamart(tree);
    const res = await walk(tree, up);
    expect(up.calls).toEqual([
      OFFICE,
      `${OFFICE}18/`,
      `${OFFICE}19/`,
      ...FILES_18.map((f) => `${OFFICE}18/${f}`),
      ...FILES_19.map((f) => `${OFFICE}19/${f}`),
    ]);
    expect(res.buffers.map(String)).toEqual(
      [...FILES_18, ...FILES_19].map((f) => `<alert>${f}</alert>`),
    );
    expect(res.urls).toEqual([
      ...FILES_18.map((f) => `${OFFICE}18/${f}`),
      ...FILES_19.map((f) => `${OFFICE}19/${f}`),
    ]);
    expect(res.payloads).toHaveLength(7);
  });

  it("never follows a link to another host or out of the listing's directory", async () => {
    const tree = capturedTree();
    const strays = [
      '<a href="https://other.example/x.cap">x</a>',
      '<a href="../x.cap">x</a>',
      '<a href="/20261008/WXO-DD/alerts/cap/20261008/CWTO/x.cap">x</a>',
      '<a href="%2e%2e/y.cap">y</a>',
      '<a href="//other.example/z.cap">z</a>',
    ].join("\n");
    tree.set(`${OFFICE}19/`, listing("hour-19.txt").replace("<hr></pre>", `${strays}\n<hr></pre>`));
    const up = datamart(tree);
    await walk(tree, up);
    expect(up.calls.filter((c) => !c.startsWith(`${OFFICE}1`))).toEqual([OFFICE]);
    expect(up.calls.some((c) => /\/[xyz]\.cap$/.test(c))).toBe(false);
  });

  it("lists again the hour whose version changed, and an hour once more until its version repeats", async () => {
    const tree = capturedTree();
    const up = datamart(tree);
    const first = await walk(tree, up);

    // Constructed: hour 19 gains a file and loses one, and its time moves on.
    const added = "T_WHCN13_C_CWTO_202610082014_1000000001.cap";
    tree.set(OFFICE, listing("office.txt").replace("2026-10-08 20:01", "2026-10-08 20:15"));
    tree.set(
      `${OFFICE}19/`,
      listing("hour-19.txt").replace(FILES_19[0]!, added).replace(FILES_19[0]!, added),
    );
    tree.set(`${OFFICE}19/${added}`, `<alert>${added}</alert>`);
    up.calls.length = 0;
    const second = await walk(tree, up, first.kept);

    // Hour 18 is listed once more: its version was seen once, and a minute
    // can hold a write after the listing was read.
    expect(up.calls).toEqual([OFFICE, `${OFFICE}18/`, `${OFFICE}19/`, `${OFFICE}19/${added}`]);
    expect(second.buffers.map(String)).toEqual(
      // In the listing's order: the added file took the removed one's line.
      [...FILES_18, added, FILES_19[1]!].map((f) => `<alert>${f}</alert>`),
    );
    expect(second.payloads.map((p) => p.url)).toEqual([
      OFFICE,
      `${OFFICE}18/`,
      `${OFFICE}19/`,
      `${OFFICE}19/${added}`,
    ]);
    expect([...second.kept!.keys()].some((k) => k.endsWith(FILES_19[0]!))).toBe(false);

    // Hour 19's new version is confirmed once; hour 18's version repeated, so it is trusted.
    up.calls.length = 0;
    const third = await walk(tree, up, second.kept);
    expect(up.calls).toEqual([OFFICE, `${OFFICE}19/`]);
    expect(third.buffers).toHaveLength(4);

    // Nothing changed: only the unversioned office listing is asked again.
    up.calls.length = 0;
    const fourth = await walk(tree, up, third.kept);
    expect(up.calls).toEqual([OFFICE]);
    expect(fourth.buffers).toHaveLength(4);
  });

  it("a file added under an unchanged version (same minute) is fetched on the next poll", async () => {
    // Constructed: the first poll lists hour 18 between its two writes of 18:13.
    const tree = capturedTree();
    const late = FILES_18[1]!;
    tree.set(
      `${OFFICE}18/`,
      listing("hour-18.txt").replace(/^.*href="T_[^"]*2451493062\.cap".*\n/m, ""),
    );
    const up = datamart(tree);
    const first = await walk(tree, up);
    expect(first.buffers.map(String)).not.toContain(`<alert>${late}</alert>`);

    // The file lands within the same minute: the office listing still reads 18:13.
    tree.set(`${OFFICE}18/`, listing("hour-18.txt"));
    up.calls.length = 0;
    const second = await walk(tree, up, first.kept);
    expect(up.calls).toContain(`${OFFICE}18/${late}`);
    expect(second.buffers.map(String)).toContain(`<alert>${late}</alert>`);

    up.calls.length = 0;
    await walk(tree, up, second.kept);
    expect(up.calls).toEqual([OFFICE]);
  });

  it("an hour no longer listed takes its files out of the role's payloads", async () => {
    const tree = capturedTree();
    const up = datamart(tree);
    const first = await walk(tree, up);
    tree.set(OFFICE, listing("office.txt").replace(/^.*href="18\/".*\n/m, ""));
    up.calls.length = 0;
    const second = await walk(tree, up, first.kept);
    // Hour 19 is listed once more to confirm its version; hour 18 is not listed at all.
    expect(up.calls).toEqual([OFFICE, `${OFFICE}19/`]);
    expect(second.buffers.map(String)).toEqual(FILES_19.map((f) => `<alert>${f}</alert>`));
  });

  describe("a listing that fails", () => {
    const tolerantWalk = catalogFeed({
      endpoints: {
        index: { url: DAY, cadenceSec: 120 },
        alerts: {
          url: "{item}",
          cadenceSec: 120,
          fanout: "tolerant",
          each: { role: "index", links: ECCC_LINKS },
        },
      },
    });
    const walkOnce = (up: ReturnType<typeof datamart>, kept?: KeptItems) =>
      fetchEndpoint(tolerantWalk, "alerts", up.fn, {
        state: createFetchState(),
        eachSource: [Buffer.from(listing("day.txt"))],
        eachSourceUrls: [DAY],
        at: T,
        ...(kept ? { kept } : {}),
      });

    it("with nothing kept, leaves the walk partial: its subtree is missing from the snapshot", async () => {
      const tree = capturedTree();
      tree.delete(`${OFFICE}18/`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await walkOnce(datamart(tree));
        expect(res.status).toBe("partial");
        if (res.status !== "partial") return;
        expect(res.partitions.failed).toBe(1);
        expect(res.buffers.map(String)).toEqual(FILES_19.map((f) => `<alert>${f}</alert>`));
      } finally {
        warn.mockRestore();
      }
    });

    it("with a kept copy, the copy stands in and the walk is whole", async () => {
      const tree = capturedTree();
      const first = await walkOnce(datamart(tree));
      if (first.status !== "fetched") throw new Error(`unexpected ${first.status}`);

      // The office listing is asked at every walk; this time it fails.
      tree.delete(OFFICE);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const up = datamart(tree);
        const second = await walkOnce(up, first.kept);
        expect(second.status).toBe("fetched");
        if (second.status !== "fetched") return;
        // The hours below the kept office listing are listed once more to confirm their versions.
        expect(up.calls).toEqual([OFFICE, `${OFFICE}18/`, `${OFFICE}19/`]);
        expect(second.buffers.map(String)).toEqual(
          [...FILES_18, ...FILES_19].map((f) => `<alert>${f}</alert>`),
        );
        expect(second.kept!.has(OFFICE)).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    // Constructed: a 200 page with no link below it (a maintenance page, a renamed tree).
    const NO_LINKS = "<html><body><h1>Service temporarily unavailable</h1></body></html>";

    it("a listing that matches no link fails: with nothing kept, the walk is partial", async () => {
      const tree = capturedTree();
      tree.set(OFFICE, NO_LINKS);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await walkOnce(datamart(tree));
        expect(res.status).toBe("partial");
        if (res.status !== "partial") return;
        expect(res.partitions.failed).toBe(1);
        expect(res.buffers).toEqual([]);
        // Nothing kept for it: the next walk lists it again.
        expect(res.kept!.has(OFFICE)).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it("a listing that matches no link fails: its kept copy stands in", async () => {
      const tree = capturedTree();
      const first = await walkOnce(datamart(tree));
      if (first.status !== "fetched") throw new Error(`unexpected ${first.status}`);
      tree.set(OFFICE, NO_LINKS);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const second = await walkOnce(datamart(tree), first.kept);
        expect(second.status).toBe("fetched");
        if (second.status !== "fetched") return;
        expect(second.buffers.map(String)).toEqual(
          [...FILES_18, ...FILES_19].map((f) => `<alert>${f}</alert>`),
        );
        expect(second.kept!.get(OFFICE)).toBe(first.kept!.get(OFFICE));
      } finally {
        warn.mockRestore();
      }
    });

    it("a source listing that matches no link fails, and its kept copy stands in", async () => {
      const tree = capturedTree();
      const first = await walkOnce(datamart(tree));
      if (first.status !== "fetched") throw new Error(`unexpected ${first.status}`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const empty = (kept?: KeptItems) =>
          fetchEndpoint(tolerantWalk, "alerts", datamart(tree).fn, {
            state: createFetchState(),
            eachSource: [Buffer.from(NO_LINKS)],
            eachSourceUrls: [DAY],
            at: T,
            ...(kept ? { kept } : {}),
          });
        const alone = await empty();
        expect(alone.status).toBe("partial");
        const standIn = await empty(first.kept);
        expect(standIn.status).toBe("fetched");
        if (standIn.status !== "fetched") return;
        expect(standIn.buffers).toHaveLength(4);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("without fanout tolerant, a listing that matches no link fails the role", async () => {
    const tree = capturedTree();
    tree.set(`${OFFICE}18/`, "<html><body>moved</body></html>");
    await expect(walk(tree, datamart(tree))).rejects.toThrow(/matched no link/);
  });

  it("a walk needs the source role's URLs", async () => {
    await expect(
      fetchEndpoint(walkFeed(), "alerts", datamart(new Map()).fn, {
        state: createFetchState(),
        eachSource: [Buffer.from(listing("day.txt"))],
      }),
    ).rejects.toThrow(/URLs/);
  });

  it("the source of a walk may answer with a listing page, and yields its URLs", async () => {
    const tree = capturedTree();
    const up = datamart(tree);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await fetchEndpoint(walkFeed(), "index", up.fn, {
        state: createFetchState(),
        at: T,
      });
      // Yesterday's directory answers 404 here; today's is the listing.
      expect(res.status).toBe("partial");
      if (res.status !== "partial") return;
      expect(res.urls).toEqual([DAY]);
      expect(res.buffers.map(String)).toEqual([listing("day.txt")]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("endpointSchema each", () => {
  const base = { url: "https://api.test/stations/{item}", cadenceSec: 60, each: EACH };

  it("accepts a url with {item}", () => {
    expect(endpointSchema.safeParse(base).success).toBe(true);
    expect(endpointSchema.safeParse({ ...base, fanout: "tolerant" }).success).toBe(true);
  });

  it("rejects a url without {item}, and urls, expand, follow, pagination alongside", () => {
    expect(endpointSchema.safeParse({ ...base, url: "https://api.test/stations" }).success).toBe(
      false,
    );
    expect(
      endpointSchema.safeParse({
        ...base,
        url: undefined,
        urls: ["https://api.test/stations/{item}"],
      }).success,
    ).toBe(false);
    expect(endpointSchema.safeParse({ ...base, expand: "${key}" }).success).toBe(false);
    expect(endpointSchema.safeParse({ ...base, follow: { path: "a" } }).success).toBe(false);
    expect(
      endpointSchema.safeParse({ ...base, pagination: { skipParam: "o", pageSize: 5 } }).success,
    ).toBe(false);
  });

  it("rejects an each with a missing part", () => {
    expect(
      endpointSchema.safeParse({ ...base, each: { role: "sites", records: "x" } }).success,
    ).toBe(false);
  });
});
