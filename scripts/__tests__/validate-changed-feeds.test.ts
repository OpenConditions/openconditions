import { describe, expect, it, vi } from "vitest";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
import {
  changedFeedFiles,
  checkChangedFeeds,
  formatAnnotations,
  isFeedFile,
  isKeyless,
} from "../validate-changed-feeds.js";

function feed(over: Partial<FeedSourceBase>): FeedSourceBase {
  return {
    id: "x",
    name: "X",
    operator: "test",
    format: "geojson",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "t",
    country: "NL",
    privacyUrl: "https://example.org/privacy",
    ...over,
  };
}

describe("isFeedFile", () => {
  it("matches feed data files and rejects code/docs", () => {
    expect(isFeedFile("packages/roads/feeds/roads/nl.json5")).toBe(true);
    expect(isFeedFile("packages/roads/feeds/roads/us.json")).toBe(true);
    expect(isFeedFile("packages/roads/src/feeds.ts")).toBe(false);
    expect(isFeedFile("README.md")).toBe(false);
  });
});

describe("isKeyless", () => {
  it("is true only for feeds that need no operator secret", () => {
    expect(isKeyless(feed({ auth: { kind: "none" } }))).toBe(true);
    expect(isKeyless(feed({}))).toBe(true); // no auth at all
    expect(isKeyless(feed({ requiredEnv: ["FOO"] }))).toBe(false);
    expect(
      isKeyless(feed({ auth: { kind: "header-key", header: "X-Api-Key", envVar: "K" } }))
    ).toBe(false);
    // a query-key with a published default works with no env → still keyless
    expect(
      isKeyless(
        feed({ auth: { kind: "query-key", param: "key", envVar: "K", defaultValue: "pub" } })
      )
    ).toBe(true);
  });
});

describe("changedFeedFiles", () => {
  it("runs the diff against the base ref and keeps only feed files", () => {
    const git = vi.fn(
      () => "packages/roads/feeds/roads/nl.json5\nREADME.md\npackages/roads/src/feeds.ts\n"
    );
    const files = changedFeedFiles("origin/main", git);
    expect(files).toEqual(["packages/roads/feeds/roads/nl.json5"]);
    expect(git).toHaveBeenCalledWith([
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
      "origin/main...HEAD",
      "--",
      "packages/*/feeds/**",
    ]);
  });
});

describe("checkChangedFeeds", () => {
  it("flags the failing keyless feed and notes the skipped keyed one", async () => {
    const load = vi.fn(async () => [
      feed({ id: "good-keyless", auth: { kind: "none" } }),
      feed({
        id: "needs-key",
        auth: { kind: "header-key", header: "X-Api-Key", envVar: "FOO_KEY" },
      }),
    ]);
    const validate = vi.fn(async (f: FeedSourceBase) =>
      f.id === "good-keyless"
        ? { ok: false, rowCount: 0, failureKind: "parse" as const, message: "0 records parsed" }
        : { ok: true, rowCount: 5 }
    );

    const summary = await checkChangedFeeds({
      changedFiles: ["packages/roads/feeds/roads/nl.json5"],
      load,
      validate,
    });

    // the keyed feed is skipped BEFORE any fetch
    expect(validate).toHaveBeenCalledTimes(1);
    expect(summary.parseFailures).toBe(1);
    expect(summary.upstreamFlakes).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.outcomes.find((o) => o.feedId === "good-keyless")?.status).toBe("parse-failure");
    expect(summary.outcomes.find((o) => o.feedId === "needs-key")?.status).toBe("skipped-keyed");

    const ann = formatAnnotations(summary);
    expect(ann.some((l) => l.startsWith("::error ") && l.includes("good-keyless"))).toBe(true);
    expect(ann.some((l) => l.includes("needs-key") && l.includes("skipped"))).toBe(true);
  });

  it("annotates an upstream failure as a non-gating warning, distinct from a parse failure", async () => {
    const load = vi.fn(async () => [feed({ id: "flaky", auth: { kind: "none" } })]);
    const validate = vi.fn(async () => ({
      ok: false,
      rowCount: 0,
      failureKind: "upstream" as const,
      message: "ETIMEDOUT",
    }));

    const summary = await checkChangedFeeds({ changedFiles: ["x.json5"], load, validate });

    expect(summary.upstreamFlakes).toBe(1);
    expect(summary.parseFailures).toBe(0);
    const ann = formatAnnotations(summary);
    expect(ann.some((l) => l.startsWith("::warning ") && l.includes("flaky"))).toBe(true);
    expect(ann.some((l) => l.startsWith("::error "))).toBe(false);
  });

  it("treats an unparseable feed file as a parse failure without throwing", async () => {
    const load = vi.fn(async () => {
      throw new Error("Unexpected token in JSON5");
    });
    const validate = vi.fn();

    const summary = await checkChangedFeeds({ changedFiles: ["bad.json5"], load, validate });

    expect(validate).not.toHaveBeenCalled();
    expect(summary.parseFailures).toBe(1);
    expect(summary.outcomes[0]?.status).toBe("parse-failure");
  });
});
