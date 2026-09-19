import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DigestTee, digestPayload, fsRawPayloadSink } from "../payload.js";

const BODY = Buffer.from("<d2LogicalModel>".repeat(1000));
const SHA = digestPayload("https://x", BODY).sha256;

describe("digestPayload", () => {
  it("hashes the decoded body", () => {
    expect(digestPayload("https://x", BODY)).toEqual({
      url: "https://x",
      sha256: SHA,
      bytes: BODY.length,
    });
  });
});

describe("DigestTee", () => {
  it("passes bytes through and yields the buffered digest", async () => {
    const tee = new DigestTee("https://x");
    const seen: Buffer[] = [];
    await pipeline(Readable.from([BODY.subarray(0, 7), BODY.subarray(7)]), tee, async (source) => {
      for await (const chunk of source) seen.push(chunk as Buffer);
    });
    expect(Buffer.concat(seen)).toEqual(BODY);
    expect(tee.digest()).toEqual(digestPayload("https://x", BODY));
  });
});

describe("fsRawPayloadSink", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-raw-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = {
    sourceId: "nl-ndw-situations",
    url: "https://x",
    fetchId: "1",
    fetchedAt: new Date("2026-09-18T10:00:00Z"),
  };

  it("writes a zstd blob under source/day/hash via a temp file", async () => {
    const sink = fsRawPayloadSink({ dir });
    const writer = await sink.begin(meta);
    const tee = new DigestTee(meta.url, writer);
    await pipeline(Readable.from([BODY]), tee, async (source) => {
      for await (const _ of source) {
        // a streaming parser consumes here
      }
    });
    const stored = await writer.commit(tee.digest().sha256);
    expect(stored).toMatchObject({
      storageKey: `nl-ndw-situations/2026-09-18/${SHA}.zst`,
      created: true,
    });
    const blob = await readFile(join(dir, stored.storageKey));
    expect(zstdDecompressSync(blob)).toEqual(BODY);
    expect(
      (await readdir(join(dir, "nl-ndw-situations"))).filter((f) => f.startsWith(".tmp-")),
    ).toEqual([]);
  });

  it("keeps one blob for an identical payload the same day", async () => {
    const sink = fsRawPayloadSink({ dir });
    for (const expected of [true, false]) {
      const writer = await sink.begin(meta);
      writer.write(BODY);
      expect((await writer.commit(SHA)).created).toBe(expected);
    }
    expect(await readdir(join(dir, "nl-ndw-situations", "2026-09-18"))).toEqual([`${SHA}.zst`]);
  });

  it("leaves nothing behind on abort", async () => {
    const writer = await fsRawPayloadSink({ dir }).begin(meta);
    writer.write(BODY);
    await writer.abort();
    expect(await readdir(join(dir, "nl-ndw-situations"))).toEqual([]);
  });

  it("refuses a source id that is not a slug", async () => {
    await expect(
      fsRawPayloadSink({ dir }).begin({ ...meta, sourceId: "../etc" }),
    ).rejects.toThrow();
  });
});
