import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { downloadLargeArtifact } from "../download.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function fakeFetch(map: Record<string, { status?: number; body?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const entry = map[String(input)];
    if (!entry) return new Response(null, { status: 404 });
    return new Response(entry.body ?? null, { status: entry.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("downloadLargeArtifact", () => {
  it("streams the body to a temp file and returns bytes + md5", async () => {
    const data = "PBF-BYTES-123";
    const f = fakeFetch({
      "http://x/a.pbf": { body: data },
      "http://x/a.pbf.md5": { body: `${md5(data)}  a.pbf` },
    });
    const r = await downloadLargeArtifact("http://x/a.pbf", { fetchImpl: f });
    try {
      expect(r.bytes).toBe(Buffer.byteLength(data));
      expect(r.md5).toBe(md5(data));
      expect(readFileSync(r.path, "utf8")).toBe(data);
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  it("throws (and cleans up) when the md5 sidecar disagrees — truncation defense", async () => {
    const f = fakeFetch({
      "http://x/a.pbf": { body: "DATA" },
      "http://x/a.pbf.md5": { body: `${md5("OTHER")}  a.pbf` },
    });
    await expect(downloadLargeArtifact("http://x/a.pbf", { fetchImpl: f })).rejects.toThrow(
      /md5 mismatch/
    );
  });

  it("skips verification when the sidecar is absent (404)", async () => {
    const data = "NOMD5";
    const f = fakeFetch({ "http://x/a.pbf": { body: data } });
    const r = await downloadLargeArtifact("http://x/a.pbf", { fetchImpl: f });
    try {
      expect(r.md5).toBe(md5(data));
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  });

  it("throws on a non-ok download response", async () => {
    const f = fakeFetch({ "http://x/a.pbf": { status: 500, body: "" } });
    await expect(downloadLargeArtifact("http://x/a.pbf", { fetchImpl: f })).rejects.toThrow(
      /HTTP 500/
    );
  });
});
