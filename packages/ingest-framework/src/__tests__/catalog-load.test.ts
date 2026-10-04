import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { missingCredentials } from "../auth.js";
import { loadCatalog, readCatalogDir } from "../catalog/load.js";
import type { ChildFeed } from "../catalog/resolvers.js";
import { resolveEndpointUrls } from "../catalog/templates.js";
import { fixture, otherDomain, testDomain, testDomainWith } from "./helpers/catalog-domain.js";

const feed = (operator: string, name = operator) => ({
  operator,
  product: "events",
  name,
  format: "datex2",
  tier: "authoritative",
  endpoints: { main: { url: `https://example.test/${operator}`, cadenceSec: 300 } },
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: operator,
  privacyUrl: "https://example.test/privacy",
});

const bundle = (feeds: object[]) =>
  JSON.stringify({
    files: { "roads/de": { $schema: "../schema/roads.schema.json", feeds } },
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oc-catalog-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("readCatalogDir", () => {
  test("comments and trailing commas parse", () => {
    const { files, credentials } = readCatalogDir(fixture("comments"), [testDomain]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ domain: "roads", region: "de", maintainers: [] });
    expect(files[0]?.feeds.map((f) => f.name)).toEqual(["Commented feed"]);
    expect(credentials.groups).toEqual({});
  });

  test("a syntax error names file, line and column", () => {
    expect(() => readCatalogDir(fixture("broken-syntax"), [testDomain])).toThrow(
      /roads\/de\.jsonc:4:\d+/,
    );
  });

  test("one id in two files fails naming both", () => {
    expect(() => readCatalogDir(fixture("duplicate-id"), [testDomain, otherDomain])).toThrow(
      /x-op-events.*roads\/xx\.jsonc.*other\/xx\.jsonc/s,
    );
  });

  test("a schema error names the file and the feed's path", async () => {
    // A stray file beside the domain directories is not read.
    await writeFile(path.join(dir, "roads.jsonc"), "{");
    await mkdir(path.join(dir, "roads"));
    await writeFile(
      path.join(dir, "roads", "de.jsonc"),
      JSON.stringify({ feeds: [feed("ok"), { ...feed("bad"), endpoints: {} }] }),
    );
    expect(() => readCatalogDir(dir, [testDomain])).toThrow(
      /roads\/de\.jsonc feeds\[1\]\.endpoints/,
    );
  });

  test("an unknown domain directory is an error; the schema directory is not", async () => {
    await mkdir(path.join(dir, "schema"));
    await mkdir(path.join(dir, "parking"));
    expect(() => readCatalogDir(dir, [testDomain])).toThrow(/unknown domain directory.*parking/);
    await rmdir(path.join(dir, "parking"));
    expect(readCatalogDir(dir, [testDomain]).files).toEqual([]);
  });

  test("a reader of some domains can leave the other domains' directories unread", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(
      path.join(dir, "roads", "de.jsonc"),
      JSON.stringify({ $schema: "../schema/roads.schema.json", feeds: [feed("ok")] }),
    );
    await mkdir(path.join(dir, "fuel"));
    // Not a roads region file: it would not parse as one, and is never read.
    await writeFile(path.join(dir, "fuel", "es.jsonc"), JSON.stringify({ feeds: [{ x: 1 }] }));
    expect(() => readCatalogDir(dir, [testDomain])).toThrow(/unknown domain directory.*fuel/);
    const { files } = readCatalogDir(dir, [testDomain], { otherDomains: "ignore" });
    expect(files.map((f) => [f.domain, f.region])).toEqual([["roads", "de"]]);
  });

  test("a file in a domain directory that is not .jsonc is an error naming it", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(path.join(dir, "roads", "de.jsonc"), JSON.stringify({ feeds: [] }));
    await writeFile(path.join(dir, "roads", "nl.json5"), "{ feeds: [] }");
    expect(() => readCatalogDir(dir, [testDomain])).toThrow(/roads\/nl\.json5: not a region file/);
  });

  test("a hidden file in a domain directory is skipped", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(path.join(dir, "roads", "de.jsonc"), JSON.stringify({ feeds: [feed("ok")] }));
    await writeFile(path.join(dir, "roads", ".DS_Store"), "\u0000Bud1");
    await writeFile(path.join(dir, "roads", ".nl.jsonc.swp"), "{");
    const { files } = readCatalogDir(dir, [testDomain]);
    expect(files.map((f) => path.basename(f.path))).toEqual(["de.jsonc"]);
  });

  test("a file name must be a region", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(path.join(dir, "roads", "germany.jsonc"), JSON.stringify({ feeds: [] }));
    expect(() => readCatalogDir(dir, [testDomain])).toThrow(/germany\.jsonc/);
  });

  test("shared credentials are read by group", () => {
    const { credentials } = readCatalogDir(fixture("lone-group"), [testDomain]);
    expect(credentials.groups).toEqual({ lone: { token: { title: "Token" } } });
  });
});

describe("loadCatalog", () => {
  test("the mount layer overrides a baked feed", async () => {
    const cat = await loadCatalog([testDomain], {
      baked: fixture("baked"),
      mount: fixture("mount"),
    });
    expect(cat.feeds.find((f) => f.id === "de-ndw-events")?.name).toBe("mounted");
    expect(cat.feeds.filter((f) => f.id === "de-ndw-events")).toHaveLength(1);
  });

  test("a missing mount directory is no layer", async () => {
    const cat = await loadCatalog([testDomain], {
      baked: fixture("baked"),
      mount: path.join(dir, "absent"),
    });
    expect(cat.feeds.find((f) => f.id === "de-ndw-events")?.name).toBe("baked");
  });

  test("a disabled feed is not scheduled but kept", async () => {
    const cat = await loadCatalog([testDomain], { baked: fixture("baked") });
    expect(cat.feeds.map((f) => f.id)).not.toContain("de-dead-events");
    expect(cat.disabled.map((f) => [f.id, f.disabled?.reason])).toEqual([
      ["de-dead-events", "endpoint gone"],
    ]);
  });

  test("a feed loads with region, country, rights and cadence", async () => {
    const cat = await loadCatalog([testDomain], { baked: fixture("baked") });
    const f = cat.feeds.find((x) => x.id === "de-hh-autobahn-flow");
    expect([f?.region, f?.country, f?.cadenceSec, f?.rights.redistribution]).toEqual([
      "de",
      "DE",
      60,
      true,
    ]);
    expect(f?.coverage).toEqual({ countries: ["DE"] });
    expect(f?.maintainers).toEqual([{ name: "Test", github: "test" }]);
    expect(f?.file).toMatch(/baked\/roads\/de\.jsonc$/);
  });

  test("a shared field's default fills the feeds that read it, so none of them misses it", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(
      path.join(dir, "credentials.jsonc"),
      JSON.stringify({
        credentials: {
          overpass: { url: { title: "Overpass", default: "https://overpass.test/api" } },
        },
      }),
    );
    await writeFile(
      path.join(dir, "roads", "de.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [
          {
            ...feed("osm"),
            homepage: "https://www.openstreetmap.org/copyright",
            endpoints: { main: { url: "${@overpass.url}", cadenceSec: 300 } },
          },
        ],
      }),
    );
    const cat = await loadCatalog([testDomain], { baked: dir });
    const osm = cat.feeds.find((f) => f.id === "de-osm-events")!;
    expect(missingCredentials(osm, {})).toEqual([]);
    expect(resolveEndpointUrls(osm, "main", {})).toEqual(["https://overpass.test/api"]);
    expect(resolveEndpointUrls(osm, "main", { OVERPASS_URL: "http://own/api" })).toEqual([
      "http://own/api",
    ]);
  });

  test("a catalogue that fails the lint does not load", async () => {
    await mkdir(path.join(dir, "roads"));
    await writeFile(
      path.join(dir, "roads", "de.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [{ ...feed("bad"), license: "Some-Licence" }],
      }),
    );
    await expect(loadCatalog([testDomain], { baked: dir })).rejects.toThrow(
      /de-bad-events.*unknown licence/s,
    );
  });

  test("a remote bundle is a layer between baked and mount, and is snapshotted", async () => {
    const snapshotPath = path.join(dir, "state", "remote-snapshot.json");
    const text = bundle([feed("ndw", "remote"), feed("extra")]);
    const remoteFetch = vi.fn(async () => new Response(text));
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        remote: { url: "https://atlas.example.test/bundle.json", snapshotPath },
      },
      { remoteFetch },
    );
    expect(remoteFetch).toHaveBeenCalledWith("https://atlas.example.test/bundle.json");
    expect(cat.feeds.find((f) => f.id === "de-ndw-events")?.name).toBe("remote");
    expect(cat.feeds.map((f) => f.id)).toContain("de-extra-events");
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual(JSON.parse(text));

    const mounted = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        mount: fixture("mount"),
        remote: { url: "https://atlas.example.test/bundle.json", snapshotPath },
      },
      { remoteFetch },
    );
    expect(mounted.feeds.find((f) => f.id === "de-ndw-events")?.name).toBe("mounted");
  });

  test("a remote failure falls back to the snapshot", async () => {
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    await writeFile(snapshotPath, bundle([feed("snap")]));
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        remote: { url: "https://atlas.example.test/b.json", snapshotPath },
      },
      { remoteFetch: async () => Promise.reject(new Error("offline")) },
    );
    expect(cat.feeds.map((f) => f.id)).toContain("de-snap-events");
    expect(cat.feeds.map((f) => f.id)).toContain("de-ndw-events");
  });

  test("a remote bundle with a private URL is rejected for the snapshot", async () => {
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    await writeFile(snapshotPath, bundle([feed("snap")]));
    const evil = {
      ...feed("evil"),
      endpoints: { main: { url: "http://169.254.169.254/latest", cadenceSec: 300 } },
    };
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        remote: { url: "https://atlas.example.test/b.json", snapshotPath },
      },
      { remoteFetch: async () => new Response(bundle([evil])) },
    );
    expect(cat.feeds.map((f) => f.id)).not.toContain("de-evil-events");
    expect(cat.feeds.map((f) => f.id)).toContain("de-snap-events");
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual(
      JSON.parse(bundle([feed("snap")])),
    );
  });

  test("a remote bundle that fails the lint falls back instead of stopping the load", async () => {
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    await writeFile(snapshotPath, bundle([feed("snap")]));
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        remote: { url: "https://atlas.example.test/b.json", snapshotPath },
      },
      { remoteFetch: async () => new Response(bundle([{ ...feed("odd"), license: "Odd" }])) },
    );
    expect(cat.feeds.map((f) => f.id)).toContain("de-snap-events");
    expect(cat.feeds.map((f) => f.id)).not.toContain("de-odd-events");
  });

  test("a remote shared group of one feed is rejected before it is snapshotted", async () => {
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    const good = bundle([feed("snap")]);
    await writeFile(snapshotPath, good);
    const lone = JSON.stringify({
      files: {
        "roads/de": {
          $schema: "../schema/roads.schema.json",
          feeds: [{ ...feed("solo"), auth: { kind: "bearer", credential: "@solo.token" } }],
        },
        credentials: { credentials: { solo: { token: { title: "Token" } } } },
      },
    });
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        mount: fixture("mount"),
        remote: { url: "https://atlas.example.test/b.json", snapshotPath },
      },
      { remoteFetch: async () => new Response(lone) },
    );
    expect(cat.feeds.map((f) => f.id)).not.toContain("de-solo-events");
    expect(cat.feeds.map((f) => f.id)).toContain("de-snap-events");
    expect(cat.feeds.find((f) => f.id === "de-ndw-events")?.name).toBe("mounted");
    expect(await readFile(snapshotPath, "utf8")).toBe(good);
  });

  test("a remote group that drops a field baked feeds use is rejected, snapshot included", async () => {
    const baked = path.join(dir, "baked");
    await mkdir(path.join(baked, "roads"), { recursive: true });
    await writeFile(
      path.join(baked, "credentials.jsonc"),
      JSON.stringify({ credentials: { grp: { cert: { title: "Cert" } } } }),
    );
    const shared = { auth: { kind: "bearer", credential: "@grp.cert" } };
    await writeFile(
      path.join(baked, "roads", "de.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [
          { ...feed("a"), ...shared },
          { ...feed("b"), ...shared },
        ],
      }),
    );
    const breaking = JSON.stringify({
      files: {
        "roads/de": { $schema: "../schema/roads.schema.json", feeds: [feed("extra")] },
        credentials: { credentials: { grp: { other: { title: "Other" } } } },
      },
    });
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    const good = bundle([feed("snap")]);
    await writeFile(snapshotPath, good);
    const load = () =>
      loadCatalog(
        [testDomain],
        { baked, remote: { url: "https://atlas.example.test/b.json", snapshotPath } },
        { remoteFetch: async () => new Response(breaking) },
      );

    const cat = await load();
    expect(cat.feeds.map((f) => f.id).sort()).toEqual([
      "de-a-events",
      "de-b-events",
      "de-snap-events",
    ]);
    expect(cat.credentials.groups).toEqual({ grp: { cert: { title: "Cert" } } });
    expect(await readFile(snapshotPath, "utf8")).toBe(good);

    // A last snapshot that breaks the catalogue the same way is dropped too.
    await writeFile(snapshotPath, breaking);
    const dropped = await load();
    expect(dropped.feeds.map((f) => f.id).sort()).toEqual(["de-a-events", "de-b-events"]);
    expect(dropped.credentials.groups).toEqual({ grp: { cert: { title: "Cert" } } });
  });

  test("a remote override that leaves a baked shared group one user is rejected", async () => {
    const baked = path.join(dir, "baked");
    await mkdir(path.join(baked, "roads"), { recursive: true });
    await writeFile(
      path.join(baked, "credentials.jsonc"),
      JSON.stringify({ credentials: { grp: { token: { title: "Token" } } } }),
    );
    const shared = { auth: { kind: "bearer", credential: "@grp.token" } };
    await writeFile(
      path.join(baked, "roads", "de.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [
          { ...feed("a"), ...shared },
          { ...feed("b"), ...shared },
        ],
      }),
    );
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    const good = bundle([feed("snap")]);
    await writeFile(snapshotPath, good);

    const cat = await loadCatalog(
      [testDomain],
      { baked, remote: { url: "https://atlas.example.test/b.json", snapshotPath } },
      { remoteFetch: async () => new Response(bundle([feed("b", "keyless")])) },
    );
    expect(cat.feeds.find((f) => f.id === "de-b-events")).toMatchObject({
      name: "b",
      auth: { kind: "bearer", credential: "@grp.token" },
    });
    expect(cat.feeds.map((f) => f.id)).toContain("de-snap-events");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/shared group grp is used by 1 feed/),
    );
    expect(await readFile(snapshotPath, "utf8")).toBe(good);
  });

  test("a remote feed whose credential env name collides with a baked one is rejected", async () => {
    const baked = path.join(dir, "baked");
    await mkdir(path.join(baked, "roads"), { recursive: true });
    const keyed = (over: object, field: string) => ({
      ...feed("op"),
      ...over,
      credentials: { [field]: { title: "Key" } },
      auth: { kind: "bearer", credential: field },
    });
    await writeFile(
      path.join(baked, "roads", "de.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [keyed({ product: "flow" }, "events_k")],
      }),
    );
    const snapshotPath = path.join(dir, "remote-snapshot.json");
    const cat = await loadCatalog(
      [testDomain],
      { baked, remote: { url: "https://atlas.example.test/b.json", snapshotPath } },
      {
        remoteFetch: async () =>
          new Response(bundle([keyed({ qualifier: "flow", product: "events" }, "k")])),
      },
    );
    expect(cat.feeds.map((f) => f.id)).toEqual(["de-op-flow"]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/de-op-flow-events.*DE_OP_FLOW_EVENTS_K/),
    );
    await expect(readFile(snapshotPath, "utf8")).rejects.toThrow();
  });

  describe("a remote layer never routes the operator's credentials", () => {
    const remoteUrl = "https://atlas.example.test/b.json";
    async function bakedWithCredentials(): Promise<string> {
      const baked = path.join(dir, "baked");
      await mkdir(path.join(baked, "roads"), { recursive: true });
      await writeFile(
        path.join(baked, "credentials.jsonc"),
        JSON.stringify({ credentials: { grp: { token: { title: "Token" } } } }),
      );
      const shared = { auth: { kind: "bearer", credential: "@grp.token" } };
      await writeFile(
        path.join(baked, "roads", "de.jsonc"),
        JSON.stringify({
          $schema: "../schema/roads.schema.json",
          feeds: [
            { ...feed("a"), ...shared },
            { ...feed("b"), ...shared },
            {
              ...feed("keyed"),
              credentials: { api_key: { title: "Key" } },
              auth: { kind: "query-key", param: "key", credential: "api_key" },
            },
          ],
        }),
      );
      return baked;
    }
    const load = (baked: string, text: string, snapshotPath: string) =>
      loadCatalog(
        [testDomain],
        { baked, remote: { url: remoteUrl, snapshotPath } },
        { remoteFetch: async () => new Response(text) },
      );

    test("a remote feed that reads a shared credential group is rejected", async () => {
      const baked = await bakedWithCredentials();
      const snapshotPath = path.join(dir, "remote-snapshot.json");
      const thief = bundle([
        {
          ...feed("thief"),
          endpoints: { main: { url: "https://collector.example.org/x", cadenceSec: 300 } },
          auth: { kind: "bearer", credential: "@grp.token" },
        },
      ]);
      const cat = await load(baked, thief, snapshotPath);
      expect(cat.feeds.map((f) => f.id)).not.toContain("de-thief-events");
      expect(cat.feeds.map((f) => f.id).sort()).toEqual([
        "de-a-events",
        "de-b-events",
        "de-keyed-events",
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/de-thief-events.*shared credential @grp\.token/),
      );
      await expect(readFile(snapshotPath, "utf8")).rejects.toThrow();

      // Updating a feed that already reads the group, on its own host, is allowed.
      const update = bundle([
        { ...feed("a", "updated"), auth: { kind: "bearer", credential: "@grp.token" } },
      ]);
      const ok = await load(baked, update, snapshotPath);
      expect(ok.feeds.find((f) => f.id === "de-a-events")?.name).toBe("updated");
      const moved = bundle([
        {
          ...feed("a", "moved"),
          endpoints: { main: { url: "https://collector.example.org/a", cadenceSec: 300 } },
          auth: { kind: "bearer", credential: "@grp.token" },
        },
      ]);
      const kept = await load(baked, moved, path.join(dir, "other-snapshot.json"));
      expect(kept.feeds.find((f) => f.id === "de-a-events")?.name).toBe("a");
    });

    test("a remote override of a credentialed feed may not change its hosts", async () => {
      const baked = await bakedWithCredentials();
      const snapshotPath = path.join(dir, "remote-snapshot.json");
      const moved = bundle([
        {
          ...feed("keyed", "moved"),
          endpoints: { main: { url: "https://collector.example.org/x", cadenceSec: 300 } },
          credentials: { api_key: { title: "Key" } },
          auth: { kind: "query-key", param: "key", credential: "api_key" },
        },
      ]);
      const cat = await load(baked, moved, snapshotPath);
      const keyed = cat.feeds.find((f) => f.id === "de-keyed-events");
      expect(keyed?.name).toBe("keyed");
      expect(keyed?.endpoints["main"]?.url).toBe("https://example.test/keyed");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/de-keyed-events.*collector\.example\.org/),
      );
      await expect(readFile(snapshotPath, "utf8")).rejects.toThrow();

      // The same override on the feed's own host is an ordinary update.
      const updated = bundle([
        {
          ...feed("keyed", "updated"),
          endpoints: { main: { url: "https://example.test/keyed/v2", cadenceSec: 300 } },
          credentials: { api_key: { title: "Key" } },
          auth: { kind: "query-key", param: "key", credential: "api_key" },
        },
      ]);
      const ok = await load(baked, updated, snapshotPath);
      expect(ok.feeds.find((f) => f.id === "de-keyed-events")?.name).toBe("updated");
    });
  });

  test("without a usable snapshot a remote failure leaves the baked feeds", async () => {
    const cat = await loadCatalog(
      [testDomain],
      {
        baked: fixture("baked"),
        remote: {
          url: "https://atlas.example.test/b.json",
          snapshotPath: path.join(dir, "none.json"),
        },
      },
      { remoteFetch: async () => new Response("nope", { status: 503 }) },
    );
    expect(cat.feeds.map((f) => f.id).sort()).toEqual(["de-hh-autobahn-flow", "de-ndw-events"]);
  });

  test("approved catalogue children replace their parent; discovered ones are kept apart", async () => {
    const child = (qualifier: string, approved: boolean): ChildFeed => ({
      qualifier,
      name: qualifier,
      endpoints: { main: { url: `https://example.test/${qualifier}`, cadenceSec: 60 } },
      selectionState: approved ? "approved" : "discovered",
      ...(approved ? { terms: { note: "reviewed", reviewedAt: "2026-09-11" } } : {}),
    });
    const domain = testDomainWith([
      {
        id: "registry",
        snapshotPath: "/unused",
        snapshot: [child("a", true), child("b", false)],
        resolve: async () => [],
      },
    ]);
    await mkdir(path.join(dir, "roads"));
    await writeFile(
      path.join(dir, "roads", "us.jsonc"),
      JSON.stringify({
        $schema: "../schema/roads.schema.json",
        feeds: [
          {
            ...feed("reg"),
            catalog: { resolver: "registry", approvedChildren: ["us-reg-a-events"] },
          },
        ],
      }),
    );
    const cat = await loadCatalog([domain], { baked: dir });
    expect(cat.feeds.map((f) => f.id)).toEqual(["us-reg-a-events"]);
    expect(cat.discovered.map((f) => f.id)).toEqual(["us-reg-b-events"]);
    // Credited through the parent: the parent is a source, its children are not.
    expect(cat.sources.map((f) => f.id)).toEqual(["us-reg-events"]);
  });

  test("sources are the enabled feeds as written", async () => {
    const cat = await loadCatalog([testDomain], { baked: fixture("baked") });
    expect(cat.sources.map((f) => f.id).sort()).toEqual(["de-hh-autobahn-flow", "de-ndw-events"]);
  });
});
