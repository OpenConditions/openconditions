import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintFeedDir } from "../../scripts/feeds-lint.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-lint-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok = {
  operator: "x",
  name: "X",
  format: "geojson",
  url: "https://example.org/x.json",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "NL",
  privacyUrl: "https://example.org/privacy",
  enabledByDefault: true,
};

describe("lintFeedDir", () => {
  it("passes a clean feed dir", () => {
    writeFileSync(join(dir, "nl.json5"), JSON.stringify([ok]));
    expect(lintFeedDir(dir)).toEqual([]);
  });

  it("catches a schema-invalid file", () => {
    writeFileSync(join(dir, "bad.json5"), JSON.stringify([{ ...ok, license: undefined }]));
    expect(lintFeedDir(dir).join("\n")).toMatch(/bad\.json5/);
  });

  it("catches a private / link-local url via assertPublicUrl", () => {
    // 169.254.169.254 is the cloud-metadata SSRF target — a literal IP, so no DNS.
    writeFileSync(
      join(dir, "ssrf.json5"),
      JSON.stringify([{ ...ok, url: "http://169.254.169.254/latest/meta-data" }])
    );
    expect(lintFeedDir(dir).join("\n")).toMatch(/169\.254\.169\.254/);
  });

  it("catches a private / link-local siteTable.url", () => {
    writeFileSync(
      join(dir, "ssrf-sitetable.json5"),
      JSON.stringify([{ ...ok, siteTable: { url: "http://169.254.169.254/latest/meta-data" } }])
    );
    expect(lintFeedDir(dir).join("\n")).toMatch(/169\.254\.169\.254/);
  });

  it("catches a private / link-local stationRegistry.url", () => {
    writeFileSync(
      join(dir, "ssrf-stationregistry.json5"),
      JSON.stringify([
        {
          ...ok,
          stationRegistry: {
            url: "http://169.254.169.254/latest/meta-data",
            format: "webtris-sites",
          },
        },
      ])
    );
    expect(lintFeedDir(dir).join("\n")).toMatch(/169\.254\.169\.254/);
  });

  it("catches a url template referencing a var outside requiredEnv/auth (undeclared)", () => {
    writeFileSync(
      join(dir, "leaky.json5"),
      JSON.stringify([{ ...ok, url: "https://x.test/a?x=${DATABASE_URL}" }])
    );
    expect(lintFeedDir(dir).join("\n")).toMatch(/undeclared variable \$\{DATABASE_URL\}/);
  });

  it("catches a bodyTemplate referencing a var outside requiredEnv/auth (undeclared)", () => {
    writeFileSync(
      join(dir, "leaky-body.json5"),
      JSON.stringify([
        { ...ok, method: "POST", bodyTemplate: '<r key="${API_KEY}"/>', requiredEnv: undefined },
      ])
    );
    expect(lintFeedDir(dir).join("\n")).toMatch(/undeclared variable \$\{API_KEY\}/);
  });

  it("accepts a url template whose var is declared in requiredEnv", () => {
    writeFileSync(
      join(dir, "declared.json5"),
      JSON.stringify([{ ...ok, url: "https://x.test/a?x=${MY_VAR}", requiredEnv: ["MY_VAR"] }])
    );
    expect(lintFeedDir(dir)).toEqual([]);
  });
});

describe("lintFeedDir — guard against the real shipped feeds", () => {
  it("passes the repo's actual feeds/roads directory (every template var declared)", () => {
    const realFeedsDir = fileURLToPath(new URL("../../feeds/roads", import.meta.url));
    expect(lintFeedDir(realFeedsDir)).toEqual([]);
  });
});
