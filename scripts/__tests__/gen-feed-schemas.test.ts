import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INGEST_DOMAINS } from "../../services/ingest/src/domains.js";
import { applyOrCheckFeedSchemas } from "../gen-feed-schemas.js";
import { FEED_SCHEMA_DIR } from "../lib/catalog-paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feed-schemas-"));
  dirs.push(dir);
  return dir;
}

describe("gen-feed-schemas", () => {
  it("generated schemas match the domains", () => {
    expect(applyOrCheckFeedSchemas(FEED_SCHEMA_DIR, INGEST_DOMAINS, false).drift).toEqual([]);
  });

  it("writes one schema per domain and the credentials schema, then reports no drift", () => {
    const dir = tempDir();
    const { drift } = applyOrCheckFeedSchemas(dir, INGEST_DOMAINS, true);
    expect(drift).toEqual([]);
    const roads = JSON.parse(readFileSync(join(dir, "roads.schema.json"), "utf8"));
    expect(roads.properties.feeds.items.properties).toHaveProperty("geojson");
    expect(roads.allowTrailingCommas).toBe(true);
    const credentials = JSON.parse(readFileSync(join(dir, "credentials.schema.json"), "utf8"));
    expect(credentials.properties).toHaveProperty("credentials");
    expect(applyOrCheckFeedSchemas(dir, INGEST_DOMAINS, false).drift).toEqual([]);
  });

  it("reports a stale schema and one no domain generates", () => {
    const dir = tempDir();
    applyOrCheckFeedSchemas(dir, INGEST_DOMAINS, true);
    writeFileSync(join(dir, "roads.schema.json"), "{}\n");
    writeFileSync(join(dir, "transit.schema.json"), "{}\n");
    const { drift } = applyOrCheckFeedSchemas(dir, INGEST_DOMAINS, false);
    expect(drift).toEqual([join(dir, "roads.schema.json"), join(dir, "transit.schema.json")]);
  });
});
