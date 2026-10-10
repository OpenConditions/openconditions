import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineIngestDomain, type IngestDomain } from "../catalog/domain.js";
import {
  type CatalogResolver,
  type ChildFeed,
  materializeCatalogChildren,
  resolveWithSnapshot,
} from "../catalog/resolvers.js";
import type { CatalogFeed } from "../catalog/types.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const child = (
  qualifier: string,
  approved: boolean,
  extra: Partial<ChildFeed> = {},
): ChildFeed => ({
  qualifier,
  name: qualifier,
  endpoints: { main: { url: `https://example.test/${qualifier}`, cadenceSec: 60 } },
  selectionState: approved ? "approved" : "discovered",
  license: approved ? "CC0-1.0" : "NOASSERTION",
  terms: approved ? { note: "reviewed", reviewedAt: "2026-09-11" } : { note: "not reviewed" },
  attribution: qualifier,
  ...extra,
});

function domainWith(snapshot: readonly ChildFeed[]): IngestDomain {
  return defineIngestDomain({
    id: "roads",
    products: ["events"],
    feedShape: {},
    formats: {},
    resolvers: [{ id: "test-catalog", snapshotPath: "/unused", snapshot, resolve: async () => [] }],
  });
}

const parent: CatalogFeed = catalogFeed({
  domain: "roads",
  region: "us",
  file: "feeds/roads/us.jsonc",
  maintainers: [{ name: "M", github: "m" }],
  operator: "wzdx",
  product: "events",
  name: "US WZDx",
  format: "wzdx",
  catalog: { resolver: "test-catalog", approvedChildren: ["us-wzdx-kansas-events"] },
  credentials: { token: { title: "Token" } },
  auth: { kind: "bearer", credential: "token" },
  endpoints: { main: { url: "https://registry.test/feeds", cadenceSec: 300 } },
  license: "NOASSERTION",
  terms: { note: "registry" },
  attribution: "registry",
});

describe("materializeCatalogChildren", () => {
  it("schedules approved children as complete feeds and keeps discoveries visible", () => {
    const domains = [domainWith([child("kansas", true), child("washington", false)])];
    const result = materializeCatalogChildren([parent], domains);

    expect(result.scheduled.map((feed) => feed.id)).toEqual(["us-wzdx-kansas-events"]);
    expect(result.scheduled[0]).toMatchObject({
      id: "us-wzdx-kansas-events",
      domain: "roads",
      region: "us",
      country: "US",
      file: "feeds/roads/us.jsonc",
      maintainers: [{ name: "M", github: "m" }],
      operator: "wzdx",
      qualifier: "kansas",
      product: "events",
      format: "wzdx",
      cadenceSec: 60,
      coverage: { countries: ["US"] },
      parentSourceId: "us-wzdx-events",
      policyIds: ["us-wzdx-events", "us-wzdx-kansas-events"],
      selectionState: "approved",
      auth: { kind: "bearer", credential: "token" },
      attribution: "kansas",
      license: "CC0-1.0",
      rights: { redistribution: true, derivedRedistribution: true, commercialUse: true },
    });
    expect(result.scheduled[0]?.catalog).toBeUndefined();
    expect(result.scheduled[0]?.terms).toEqual({ note: "reviewed", reviewedAt: "2026-09-11" });
    expect(result.discovered.map((feed) => feed.id)).toEqual(["us-wzdx-washington-events"]);
    expect(result.discovered[0]).toMatchObject({
      parentSourceId: "us-wzdx-events",
      selectionState: "discovered",
      rights: { redistribution: null },
    });
  });

  it("falls back to the parent's licence and terms when the child has none", () => {
    const bare: ChildFeed = {
      qualifier: "bare",
      name: "bare",
      endpoints: { main: { url: "https://example.test/bare", cadenceSec: 60 } },
      selectionState: "discovered",
    };
    const open = catalogFeed({ ...parent, license: "CC0-1.0", terms: { note: "reviewed" } });
    const withOpen = materializeCatalogChildren(
      [{ ...open, catalog: { resolver: "test-catalog", approvedChildren: [] } }],
      [domainWith([bare])],
    );
    expect(withOpen.discovered[0]).toMatchObject({
      license: "CC0-1.0",
      terms: { note: "reviewed" },
      rights: { redistribution: true },
    });
  });

  it("revokes all child polling when the last approved child is removed", () => {
    const snapshot = [child("kansas", true), child("washington", false)];
    const revoked = { ...parent, catalog: { resolver: "test-catalog", approvedChildren: [] } };
    const result = materializeCatalogChildren([revoked], [domainWith(snapshot)]);
    expect(result.scheduled).toEqual([]);
    expect(result.discovered.map((feed) => feed.id)).toEqual([
      "us-wzdx-kansas-events",
      "us-wzdx-washington-events",
    ]);
  });

  it("preserves parent-managed catalogs when child approval is not configured", () => {
    const parentManaged = { ...parent, catalog: { resolver: "test-catalog" } };
    expect(materializeCatalogChildren([parentManaged], [domainWith([])])).toEqual({
      scheduled: [parentManaged],
      discovered: [],
      issues: [],
    });
  });

  it("passes feeds without a catalogue through", () => {
    const plain = catalogFeed({ domain: "roads" });
    expect(materializeCatalogChildren([plain], [])).toEqual({
      scheduled: [plain],
      discovered: [],
      issues: [],
    });
  });

  it("skips a discovered child it cannot resolve, with a warning naming resolver and child", () => {
    const odd = child("odd", false, { license: "Not-A-Licence", terms: undefined });
    const result = materializeCatalogChildren(
      [parent],
      [domainWith([child("kansas", true), odd, child("washington", false)])],
    );
    expect(result.scheduled.map((feed) => feed.id)).toEqual(["us-wzdx-kansas-events"]);
    expect(result.discovered.map((feed) => feed.id)).toEqual(["us-wzdx-washington-events"]);
    expect(result.issues).toEqual([
      {
        level: "warning",
        file: "feeds/roads/us.jsonc",
        feedId: "us-wzdx-odd-events",
        message: expect.stringMatching(/test-catalog.*us-wzdx-odd-events.*unknown licence/),
      },
    ]);
  });

  it("fails startup on an approved child it cannot resolve", () => {
    const odd = child("kansas", true, { license: "Not-A-Licence" });
    expect(() => materializeCatalogChildren([parent], [domainWith([odd])])).toThrow(
      /us-wzdx-kansas-events.*unknown licence/,
    );
  });

  it("fails startup when configuration approves a child absent from the snapshot", () => {
    expect(() => materializeCatalogChildren([parent], [domainWith([])])).toThrow(
      /us-wzdx-kansas-events.*snapshot/,
    );
  });

  it("refuses an approved child whose rights do not admit it", () => {
    const unreviewed = child("kansas", true, { license: "NOASSERTION", terms: { note: "?" } });
    expect(() => materializeCatalogChildren([parent], [domainWith([unreviewed])])).toThrow(
      /us-wzdx-kansas-events lacks affirmative admission evidence/,
    );
    const notSelected = child("kansas", false, { license: "CC0-1.0", terms: undefined });
    expect(() => materializeCatalogChildren([parent], [domainWith([notSelected])])).toThrow(
      /admission evidence/,
    );
  });

  it("refuses an approved child whose grant carries no review date", () => {
    const undated = child("kansas", true, { terms: { note: "reviewed" } });
    expect(() => materializeCatalogChildren([parent], [domainWith([undated])])).toThrow(
      /us-wzdx-kansas-events lacks affirmative admission evidence/,
    );
    const bare = child("kansas", true, { terms: undefined });
    expect(() => materializeCatalogChildren([parent], [domainWith([bare])])).toThrow(
      /admission evidence/,
    );
  });

  it("names a resolver the parent's domain does not have", () => {
    const ghost = { ...parent, catalog: { resolver: "ghost", approvedChildren: [] } };
    expect(() => materializeCatalogChildren([ghost], [domainWith([])])).toThrow(/ghost/);
    expect(() => materializeCatalogChildren([ghost], [])).toThrow(/roads/);
  });

  it("reports two snapshot children that derive one id as an error naming resolver and id", () => {
    const twin = child("kansas", false, { name: "twin" });
    const result = materializeCatalogChildren(
      [parent],
      [domainWith([child("kansas", true), twin, child("washington", false)])],
    );
    expect(result.scheduled.map((feed) => [feed.id, feed.name])).toEqual([
      ["us-wzdx-kansas-events", "kansas"],
    ]);
    expect(result.discovered.map((feed) => feed.id)).toEqual(["us-wzdx-washington-events"]);
    expect(result.issues).toEqual([
      {
        level: "error",
        file: "feeds/roads/us.jsonc",
        feedId: "us-wzdx-kansas-events",
        message: expect.stringMatching(/test-catalog.*us-wzdx-kansas-events.*more than once/),
      },
    ]);
  });

  it("rejects two children with one id", () => {
    const twice = {
      ...parent,
      catalog: {
        resolver: "test-catalog",
        approvedChildren: ["us-wzdx-kansas-events", "us-wzdx-kansas-events"],
      },
    };
    expect(() =>
      materializeCatalogChildren([twice], [domainWith([child("kansas", true)])]),
    ).toThrow(/duplicate/);
  });
});

const fakeFetch = (() => new Response("")) as unknown as typeof fetch;
let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

async function snapshotPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "catalog-"));
  dirs.push(dir);
  return path.join(dir, "snap.json");
}

describe("resolveWithSnapshot", () => {
  it("returns live children of the parent's registry and writes the snapshot on success", async () => {
    const snap = await snapshotPath();
    await writeFile(snap, "[]\n");
    const resolve = vi.fn(async () => [child("live", true)]);
    const resolver: CatalogResolver = { id: "r", snapshotPath: snap, snapshot: [], resolve };
    const out = await resolveWithSnapshot(resolver, parent, fakeFetch);
    expect(resolve).toHaveBeenCalledWith(parent, fakeFetch);
    expect(out.map((f) => f.qualifier)).toEqual(["live"]);
    const written = JSON.parse(await readFile(snap, "utf8")) as ChildFeed[];
    expect(written[0]?.qualifier).toBe("live");
  });

  it("leaves a bundle without a vendored snapshot file alone", async () => {
    const snap = await snapshotPath();
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: snap,
      snapshot: [child("snap", true)],
      resolve: async () => [child("live", true)],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveWithSnapshot(resolver, parent, fakeFetch);
    expect(out.map((f) => f.qualifier)).toEqual(["live"]);
    expect(existsSync(snap)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the vendored snapshot when the live resolve throws", async () => {
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: await snapshotPath(),
      snapshot: [child("snap", true)],
      resolve: async () => {
        throw new Error("registry down");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveWithSnapshot(resolver, parent, fakeFetch);
    expect(out.map((f) => f.qualifier)).toEqual(["snap"]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns [] and logs when the live resolve fails and the snapshot is empty", async () => {
    const resolver: CatalogResolver = {
      id: "r",
      snapshotPath: await snapshotPath(),
      snapshot: [],
      resolve: async () => {
        throw new Error("registry down");
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await resolveWithSnapshot(resolver, parent, fakeFetch);
    expect(out).toEqual([]);
    expect(err).toHaveBeenCalled();
  });
});
