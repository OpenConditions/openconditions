import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadFeedFiles } from "../load-feeds.js";

const schema = z.object({ id: z.string(), cadenceSec: z.number().int().positive() }).strict();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-feeds-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadFeedFiles", () => {
  it("loads + validates every *.json5 array file, flattened and deterministic", () => {
    // JSON5: trailing comma + a comment, both tolerated.
    writeFileSync(join(dir, "a.json5"), `[{ id: "a1", cadenceSec: 60 /* fast */ }]`);
    writeFileSync(
      join(dir, "b.json5"),
      `[{ id: "b1", cadenceSec: 300 }, { id: "b2", cadenceSec: 300 },]`
    );
    // A non-json5 file is ignored.
    writeFileSync(join(dir, "README.md"), "ignore me");
    const feeds = loadFeedFiles(dir, schema);
    expect(feeds.map((f) => f.id)).toEqual(["a1", "b1", "b2"]);
  });

  it("throws an aggregated error naming the file + zod issue path on any invalid element", () => {
    writeFileSync(join(dir, "good.json5"), `[{ id: "ok", cadenceSec: 60 }]`);
    writeFileSync(join(dir, "bad.json5"), `[{ id: "x", cadenceSec: -1 }]`);
    expect(() => loadFeedFiles(dir, schema)).toThrowError(/bad\.json5\[0\].*cadenceSec/s);
  });

  it("throws when a file is not a top-level array", () => {
    writeFileSync(join(dir, "obj.json5"), `{ id: "x", cadenceSec: 60 }`);
    expect(() => loadFeedFiles(dir, schema)).toThrowError(/obj\.json5.*array/s);
  });
});
