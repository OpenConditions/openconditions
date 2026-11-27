import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../feeds-discover.js";
import { discoverFeeds } from "../lib/feed-discovery/discover.js";
import { baseDistribution } from "../lib/feed-discovery/normalize.js";
import { buildReport } from "../lib/feed-discovery/rank.js";
import { markdown, writeReport } from "../lib/feed-discovery/report.js";

describe("discovery command and report", () => {
  it("prints cheap help from a copy with no domains, workspace builds or dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-discovery-help-"));
    try {
      await writeFile(join(dir, "package.json"), '{"type":"module"}');
      await writeFile(join(dir, "help.ts"), await readFile("scripts/feeds-discover.ts", "utf8"));
      const result = spawnSync(process.execPath, [join(dir, "help.ts"), "--help"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Read-only metadata discovery");
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ["--unknown"],
    ["--catalog", "austria"],
    ["--format", "xml"],
    ["--format", "json", "--format", "markdown"],
    ["--output"],
    ["--catalog", "latvia", "--catalog", "latvia"],
    ["--help", "--output", "x"],
  ])("rejects invalid/conflicting arguments %j", (...args) =>
    expect(() => parseArgs(args)).toThrow("usage"),
  );
  it("selects catalogs without accepting metadata-owned paths", () => {
    expect(
      parseArgs(["--catalog", "latvia", "--catalog", "belgium", "--format", "markdown"]),
    ).toEqual({ catalogs: ["latvia", "belgium"], format: "markdown", help: false });
    expect(parseArgs([]).catalogs).toEqual(["mobidrom", "belgium", "latvia"]);
  });
  it("preserves healthy catalog results when another fails, with fixed diagnostics and no source fetches", async () => {
    const calls: string[] = [];
    const report = await discoverFeeds({
      catalogs: ["belgium", "latvia"],
      inventory: [],
      clock: () => new Date("2026-11-27"),
      fetchFn: (async (input) => {
        calls.push(String(input));
        return String(input).includes("transportdata.be")
          ? Response.json({
              success: true,
              result: {
                count: 1,
                results: [
                  {
                    id: "10000000-0000-4000-8000-000000000000",
                    title: "Parking",
                    resources: [
                      {
                        id: "20000000-0000-4000-8000-000000000000",
                        url: "https://example.org/payload",
                        license_id: "cc0-10",
                      },
                    ],
                  },
                ],
              },
            })
          : new Response("secret-body", { status: 500 });
      }) as typeof fetch,
    });
    expect(report.complete).toBe(false);
    expect(report.candidates).toHaveLength(1);
    expect(report.catalogs.map((c) => c.complete)).toEqual([true, false]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("secret-body");
  });
  it("escapes untrusted Markdown and uses redacted URLs for label and href", () => {
    const report = buildReport(
      [
        {
          ...baseDistribution("latvia", "https://example.org/d"),
          title: "[evil](javascript:alert(1)) <img onerror=x>|",
          downloadUrls: ["https://u:p@example.org/x?custom=secret"],
          themes: ["roadworks"],
        },
      ],
      [],
      new Date("2026-11-27"),
    );
    const text = markdown(report);
    expect(text).not.toContain("<img");
    expect(text).not.toContain("custom=secret");
    expect(text).not.toContain("u:p");
    expect(text).toContain("needs_review");
    expect(text).toContain("%5BREDACTED%5D");
  });
  it("writes atomically and refuses baked catalog paths, JSONC and symlink aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-discovery-output-"));
    try {
      const output = join(dir, "report.json");
      await writeFile(output, "old");
      await writeReport(output, "new");
      expect(await readFile(output, "utf8")).toBe("new");
      await expect(writeReport("feeds/report.json", "bad")).rejects.toThrow("unsafe_output");
      await expect(writeReport(join(dir, "x.JSONC"), "bad")).rejects.toThrow("unsafe_output");
      await symlink(resolve("feeds"), join(dir, "alias"));
      await expect(writeReport(join(dir, "alias", "x.json"), "bad")).rejects.toThrow(
        "unsafe_output",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("returns usage failure without metadata or filesystem error echoes", async () =>
    expect(await main(["--format", "<secret>"])).toBe(1));
});
