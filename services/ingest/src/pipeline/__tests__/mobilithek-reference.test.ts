import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testFeed } from "../../__tests__/helpers/catalog.js";
import { resolveMobilithekReference } from "../mobilithek-reference.js";
import { clearReferenceCaches, loadReference } from "../reference.js";

const SITES = readFileSync(
  new URL(
    "../../../../../packages/roads/src/__tests__/fixtures/ndw-flow/measurement_site_table.xml",
    import.meta.url,
  ),
);

const REFERENCE = {
  kind: "mobilithek",
  offerId: "748580849261105152",
  fileNamePrefix: "D2MSTPub_LVE_",
} as const;

const METADATA_URL =
  "https://mobilithek.info/mdp-api/mdp-msa-metadata/v2/offers/748580849261105152";

/** The offer's metadata, as Mobilithek lists its content-standard files. */
const METADATA = {
  contentStandard: [
    { instance: { fileName: "D2MSTPub_LVE_125_12.xml" }, modified: "2026-03-01T00:00:00Z" },
    { instance: { fileName: "D2MSTPub_LVE_125_13.xml" }, modified: "2026-06-01T00:00:00Z" },
    { instance: { fileName: "DATEX_II_3_schema.xsd.zip" }, modified: "2026-09-01T00:00:00Z" },
    { instance: { fileName: "Lizenz.pdf" }, modified: "2026-09-02T00:00:00Z" },
    {
      accessURL:
        "https://mobilithek.info/mdp-api/files/aux/748580849261105152/D2MSTPub_LVE_125_14.xml",
      modified: "2026-08-01T00:00:00Z",
    },
  ],
};

function stubFetch(files: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const respond = files[url];
    return respond ? respond() : new Response("not found", { status: 404 });
  });
}

describe("resolveMobilithekReference", () => {
  it("names the latest file of the offer whose name starts with the prefix", async () => {
    const fetchFn = stubFetch({
      [METADATA_URL]: () =>
        Response.json({
          contentStandard: METADATA.contentStandard.filter((e) => !e.accessURL?.endsWith(".xml")),
        }),
    });
    expect(await resolveMobilithekReference(REFERENCE, fetchFn as never)).toBe(
      "https://mobilithek.info/mdp-api/files/aux/748580849261105152/D2MSTPub_LVE_125_13.xml",
    );
    expect(fetchFn).toHaveBeenCalledWith(METADATA_URL);
  });

  it("reads a file name from its access URL when the instance names none", async () => {
    const fetchFn = stubFetch({ [METADATA_URL]: () => Response.json(METADATA) });
    expect(await resolveMobilithekReference(REFERENCE, fetchFn as never)).toBe(
      "https://mobilithek.info/mdp-api/files/aux/748580849261105152/D2MSTPub_LVE_125_14.xml",
    );
  });

  it("throws when no file of the offer matches the prefix", async () => {
    const fetchFn = stubFetch({
      [METADATA_URL]: () =>
        Response.json({ contentStandard: [{ instance: { fileName: "x.xml" } }] }),
    });
    await expect(resolveMobilithekReference(REFERENCE, fetchFn as never)).rejects.toThrow(
      /no file matching D2MSTPub_LVE_/,
    );
  });

  it("throws on a failed metadata request", async () => {
    const fetchFn = stubFetch({});
    await expect(resolveMobilithekReference(REFERENCE, fetchFn as never)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("loadReference — a Mobilithek reference endpoint", () => {
  beforeEach(() => clearReferenceCaches());

  it("fetches the latest file of the offer and decodes it like a url endpoint", async () => {
    const latest =
      "https://mobilithek.info/mdp-api/files/aux/748580849261105152/D2MSTPub_LVE_125_14.xml";
    const fetchFn = stubFetch({
      [METADATA_URL]: () => Response.json(METADATA),
      [latest]: () => new Response(new Uint8Array(SITES), { status: 200 }),
    });
    const feed = testFeed({
      id: "de-by-autobahn-flow",
      product: "flow",
      format: "datex2-measured",
      endpoints: {
        main: { url: "https://example.test/measured.xml", cadenceSec: 60 },
        sites: { reference: REFERENCE, decoder: "datex2-sites", cadenceSec: 21600 },
      },
    });

    const sites = await loadReference(feed, "sites", fetchFn as never, Date.now);
    expect((sites as Map<string, unknown>).size).toBeGreaterThan(0);
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([METADATA_URL, latest]);
    // Fetched without explicit headers: the endpoint declares none.
    expect(fetchFn.mock.calls[1]?.[1]).toBeUndefined();
  });
});
