import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IngestDomain, loadCatalog, readCatalogDir } from "@openconditions/ingest-framework";
import { autobahnIndexResolver } from "@openconditions/roads";
import { afterEach, describe, expect, it } from "vitest";
import { INGEST_DOMAINS, loadIngestCatalog } from "../../services/ingest/src/domains.js";
import { buildAtlas, resolverParent } from "../export-atlas.js";
import { FEEDS_DIR, REPO_ROOT } from "../lib/catalog-paths.js";

const roads = INGEST_DOMAINS.find((d) => d.id === "roads") as IngestDomain;
const repo = readCatalogDir(FEEDS_DIR, INGEST_DOMAINS);
const vendored = new Map(roads.resolvers.map((r) => [r.id, r.snapshot]));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ids = (feeds: readonly { id: string }[]) => feeds.map((f) => f.id).sort();

describe("buildAtlas", () => {
  it("is a remote bundle the loader admits over the baked catalogue, feed for feed", async () => {
    const atlas = buildAtlas(roads, repo, vendored, REPO_ROOT);
    for (const [key, file] of Object.entries(atlas.files)) {
      if (key !== "credentials") {
        expect(file).toMatchObject({ $schema: "../schema/roads.schema.json" });
      }
    }

    // Over the baked catalogue, as an instance pulls it: a remote layer may
    // update a credentialed feed in place but never introduce one, so every
    // shared-credential feed it carries must match a baked feed.
    const dir = mkdtempSync(join(tmpdir(), "oc-atlas-"));
    dirs.push(dir);
    const snapshotPath = join(dir, "remote.json");
    const fromAtlas = await loadCatalog(
      INGEST_DOMAINS,
      {
        baked: FEEDS_DIR,
        remote: { url: "https://atlas.example.org/roads.json", snapshotPath },
      },
      { remoteFetch: (async () => new Response(JSON.stringify(atlas))) as typeof fetch },
    );
    // The snapshot is written only for an admitted remote layer.
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(atlas);
    const baked = await loadIngestCatalog({});
    expect(ids(fromAtlas.feeds)).toEqual(ids(baked.feeds));
    expect(ids(fromAtlas.discovered)).toEqual(ids(baked.discovered));
    expect(ids(fromAtlas.disabled)).toEqual(ids(baked.disabled));
  });

  it("lists every catalogue child under its parent, by the new child ids", () => {
    const { feeds } = buildAtlas(roads, repo, vendored, REPO_ROOT);
    const children = (parent: string) => feeds.filter((f) => f.parentSourceId === parent);

    const autobahn = children("de-autobahn-events");
    expect(autobahn).toHaveLength(autobahnIndexResolver.snapshot.length);
    expect(autobahn.every((f) => f.id.startsWith("de-autobahn-"))).toBe(true);

    const wzdx = children("us-wzdx-events");
    expect(wzdx.length).toBeGreaterThan(10);
    expect(wzdx.every((f) => f.id.startsWith("us-wzdx-"))).toBe(true);
    expect(wzdx.find((f) => f.id === "us-wzdx-fe9b3423ea03546f-events")).toMatchObject({
      selectionState: "approved",
      parentSourceId: "us-wzdx-events",
    });

    expect(feeds.filter((f) => f.id === "de-autobahn-events")).toHaveLength(1);
    expect(new Set(ids(feeds)).size).toBe(feeds.length);
  });

  it("expands the children it is given, so a live resolve replaces the vendored snapshot", async () => {
    const index = JSON.parse(
      readFileSync(
        new URL(
          "../../packages/roads/src/__tests__/fixtures/autobahn/road-index.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const parent = resolverParent(repo.files, autobahnIndexResolver.id);
    const requested: string[] = [];
    const live = await autobahnIndexResolver.resolve(parent!, (async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(index));
    }) as typeof fetch);
    // The registry is the one the catalogue's parent names.
    expect(requested).toEqual(["https://verkehr.autobahn.de/o/autobahn/"]);
    const { feeds } = buildAtlas(
      roads,
      repo,
      new Map([...vendored, [autobahnIndexResolver.id, live]]),
      REPO_ROOT,
    );
    expect(feeds.filter((f) => f.parentSourceId === "de-autobahn-events")).toHaveLength(
      live.length,
    );
  });

  it("names each feed's region file relative to the repository", () => {
    const { feeds } = buildAtlas(roads, repo, vendored, REPO_ROOT);
    expect(feeds.every((f) => /^feeds\/roads\/[a-z]+\.jsonc$/.test(f.file))).toBe(true);
  });
});
