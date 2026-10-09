import { describe, expect, it } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { digestPayload } from "../payload.js";
import { unzipEntries } from "../zip.js";
import { catalogFeed } from "./helpers/catalog-feed.js";
import { buildZip } from "./helpers/zip.js";

const LIMITS = { maxEntries: 10, maxBytes: 1024 * 1024 };

describe("unzipEntries", () => {
  it("returns stored and deflated entries in name order", () => {
    const zip = buildZip([
      { name: "b.xml", data: "<b/>", method: 8 },
      { name: "a.xml", data: "<a/>", method: 0 },
    ]);
    const entries = unzipEntries(zip, LIMITS);
    expect(entries.map((e) => e.name)).toEqual(["a.xml", "b.xml"]);
    expect(entries.map((e) => e.data.toString())).toEqual(["<a/>", "<b/>"]);
  });

  it("keeps only the entries whose name matches, and skips directories", () => {
    const zip = buildZip([
      { name: "README.txt", data: "read me" },
      { name: "alerts/", data: "", method: 0 },
      { name: "alerts/x.xml", data: "<x/>" },
    ]);
    const entries = unzipEntries(zip, { ...LIMITS, entries: /\.xml$/ });
    expect(entries.map((e) => e.name)).toEqual(["alerts/x.xml"]);
  });

  it("reads a large deflated entry back whole", () => {
    const big = "<alert>".repeat(50_000);
    const [entry] = unzipEntries(buildZip([{ name: "a.xml", data: big }]), LIMITS);
    expect(entry!.data.toString()).toBe(big);
  });

  it("refuses an archive with more entries than maxEntries", () => {
    const zip = buildZip(
      Array.from({ length: 4 }, (_, i) => ({ name: `${i}.xml`, data: `<${i}/>` })),
    );
    expect(unzipEntries(zip, { ...LIMITS, maxEntries: 4 })).toHaveLength(4);
    expect(() => unzipEntries(zip, { ...LIMITS, maxEntries: 3 })).toThrow(/entries/);
  });

  it("refuses an entry inflating past maxBytes, whatever its header declares", () => {
    const data = "x".repeat(5000);
    expect(() =>
      unzipEntries(buildZip([{ name: "a.xml", data }]), { ...LIMITS, maxBytes: 4999 }),
    ).toThrow(/maxBytes|bytes/);
    expect(() =>
      unzipEntries(buildZip([{ name: "a.xml", data, declaredSize: 10 }]), {
        ...LIMITS,
        maxBytes: 4999,
      }),
    ).toThrow(/bytes/);
    // The bound is on the total, over every entry.
    const two = buildZip([
      { name: "a.xml", data: "x".repeat(3000) },
      { name: "b.xml", data: "y".repeat(3000) },
    ]);
    expect(() => unzipEntries(two, { ...LIMITS, maxBytes: 5000 })).toThrow(/bytes/);
    expect(unzipEntries(two, { ...LIMITS, maxBytes: 6000 })).toHaveLength(2);
  });

  it("refuses a ZIP64 archive", () => {
    const zip = buildZip([{ name: "a.xml", data: "<a/>" }], { zip64: true });
    expect(() => unzipEntries(zip, LIMITS)).toThrow(/ZIP64/);
  });

  it("refuses an encrypted entry", () => {
    const zip = buildZip([
      { name: "a.xml", data: "<a/>" },
      { name: "b.xml", data: "<b/>", flags: 1 },
    ]);
    expect(() => unzipEntries(zip, LIMITS)).toThrow(/encrypted/);
  });

  it("an unzip endpoint's payloads are the matching entries; the zip is the payload digest", async () => {
    const zip = buildZip([
      { name: "README.txt", data: "read me" },
      { name: "Z_CAP_2.xml", data: "<alert>2</alert>" },
      { name: "Z_CAP_1.xml", data: "<alert>1</alert>", method: 0 },
    ]);
    const feed = catalogFeed({
      endpoints: {
        main: {
          url: "https://dwd.test/latest.zip",
          cadenceSec: 300,
          unzip: { entries: "\\.xml$" },
        },
      },
    });
    const fn = (async () => new Response(new Uint8Array(zip))) as unknown as typeof fetch;
    const res = await fetchEndpoint(feed, "main", fn, { state: createFetchState() });
    if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
    expect(res.buffers.map((b) => b.toString())).toEqual(["<alert>1</alert>", "<alert>2</alert>"]);
    expect(res.urls).toEqual(["https://dwd.test/latest.zip", "https://dwd.test/latest.zip"]);
    expect(res.payloads).toEqual([digestPayload("https://dwd.test/latest.zip", zip)]);
    expect(res.responses).toEqual([zip]);

    const all = catalogFeed({
      endpoints: { main: { url: "https://dwd.test/latest.zip", cadenceSec: 300, unzip: {} } },
    });
    const every = await fetchEndpoint(all, "main", fn, { state: createFetchState() });
    if (every.status !== "fetched") throw new Error(`unexpected ${every.status}`);
    expect(every.buffers).toHaveLength(3);

    const bounded = catalogFeed({
      endpoints: {
        main: { url: "https://dwd.test/latest.zip", cadenceSec: 300, unzip: { maxEntries: 2 } },
      },
    });
    await expect(fetchEndpoint(bounded, "main", fn, { state: createFetchState() })).rejects.toThrow(
      /entries/,
    );
  });

  it("refuses a method other than stored or deflate, a corrupt entry and a non-zip body", () => {
    const zip = buildZip([{ name: "a.xml", data: "<a/>", method: 0 }]);
    // Method 12 (bzip2) in the central directory.
    const bzip = Buffer.from(zip);
    bzip.writeUInt16LE(12, bzip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(() => unzipEntries(bzip, LIMITS)).toThrow(/method/);
    // A flipped data byte fails the checksum.
    const corrupt = Buffer.from(zip);
    corrupt[30 + "a.xml".length] = 0x3e;
    expect(() => unzipEntries(corrupt, LIMITS)).toThrow(/checksum|CRC/i);
    expect(() => unzipEntries(Buffer.from("<html>not a zip</html>"), LIMITS)).toThrow(/zip/i);
  });
});
