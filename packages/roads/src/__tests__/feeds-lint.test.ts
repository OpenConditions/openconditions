import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  id: "x",
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
});
