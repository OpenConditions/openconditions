import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCatalog } from "@openconditions/ingest-framework";
import { expect, it, vi } from "vitest";
import { INGEST_DOMAINS } from "../../services/ingest/src/domains.js";
import { checkFeeds } from "../feeds-check.js";
import { qualifyPun } from "../qualify-pun.js";

it("keeps qualified PUN in scheduler input and normal checker makes zero provider calls", async () => {
  const baked = path.resolve("feeds");
  const catalog = await loadCatalog(INGEST_DOMAINS, { baked });
  expect(catalog.feeds.some((f) => f.id === "it-agid-pun-charging")).toBe(true);
  expect(catalog.disabled.some((f) => f.id === "it-agid-pun-charging")).toBe(false);
  const fetch = vi.fn(async () => {
    throw Error("provider must not be called");
  });
  const results = await checkFeeds({
    feedsDir: baked,
    files: [path.join(baked, "charging/it.jsonc")],
    fetch,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(results).toEqual([
    expect.objectContaining({ level: "skipped", skipReason: "configuration" }),
  ]);
});

it("rejects implicit qualification without loading or fetching provider data", async () => {
  await expect(qualifyPun([])).rejects.toThrow(/explicit --full-generation/);
});

it("normal checker excludes an enabled PUN entry with default runtime settings", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pun-check-"));
  try {
    mkdirSync(path.join(dir, "charging"));
    const source = readFileSync("feeds/charging/it.jsonc", "utf8").replace(
      /"disabled": \{[^}]+\},/s,
      "",
    );
    writeFileSync(path.join(dir, "charging/it.jsonc"), source);
    const fetch = vi.fn(async () => {
      throw Error("must not call provider");
    });
    const result = await checkFeeds({
      feedsDir: dir,
      fetch,
      env: {},
    });
    expect(result).toEqual([
      expect.objectContaining({ level: "skipped", skipReason: "configuration" }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
