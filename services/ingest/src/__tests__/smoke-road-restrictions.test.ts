import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LookupFn } from "@openconditions/ingest-framework";
import { runRestrictionSmoke } from "../ops/smoke-road-restrictions.js";

/**
 * The smoke command, offline. Fixture responses and a fake DNS lookup keep this
 * suite hermetic: it never contacts a network and never needs Docker. The real
 * database path is proved by the restriction integration suites.
 */

const FIXTURE_URL = new URL(
  "../../../../packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json",
  import.meta.url
);

const V2 = "https://tie.digitraffic.fi/api/traffic-message/v2";
const ROADWORKS = `${V2}/roadworks`;
const EMPTY = { type: "FeatureCollection", features: [] };
const CHECKED_AT = "2026-09-12T07:14:00.000Z";

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function roadworks(): { type: string; features: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as {
    type: string;
    features: Array<Record<string, unknown>>;
  };
}

function serve(payload: unknown, opts: { failWeights?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (opts.failWeights && url.includes("weight-restrictions")) {
      return new Response("upstream down", { status: 503 });
    }
    const body = url.startsWith(ROADWORKS) ? payload : EMPTY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: 'W/"smoke"',
        "last-modified": "Fri, 12 Sep 2026 07:00:00 GMT",
      },
    });
  }) as unknown as typeof fetch;
}

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "oc-smoke-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe("runRestrictionSmoke", () => {
  it("accounts for a four-partition run and reports the verified restrictions", async () => {
    const report = await runRestrictionSmoke(
      { sourceId: "fi-digitraffic", outputDir },
      { fetch: serve(roadworks()), lookup: fakeLookup, now: () => CHECKED_AT }
    );
    expect(report.mode).toBe("validation-only");
    expect(report.checkedAt).toBe(CHECKED_AT);
    expect(report.feedUrls).toHaveLength(4);
    expect(report.requests).toHaveLength(4);
    expect(report.requests.every((request) => request.status === 200)).toBe(true);
    expect(report.requests.some((request) => request.etag === 'W/"smoke"')).toBe(true);
    expect(report.snapshot).toMatchObject({
      inputCount: 5,
      uniqueCount: 5,
      accepted: 5,
      terminal: 0,
      unlocatable: 0,
    });
    expect(report.restrictions.recordsWithDetails).toBe(5);
    expect(report.restrictions.facts).toBeGreaterThanOrEqual(8);
    expect(report.restrictions.kinds["gross_weight:kg"]).toBeGreaterThanOrEqual(3);
    expect(report.restrictions.scopes["detour"]).toBe(1);
    expect(report.restrictions.unsupportedEnvelopes).toBe(0);
    expect(report.withheldExports).toMatchObject({
      datexSituations: 5,
      traffMessages: 5,
      valhallaExclusions: 5,
    });
    expect(report.provenance).toMatchObject({
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      termsUrl: "https://www.digitraffic.fi/en/terms-of-service/",
      publisher: "Fintraffic / Digitraffic",
    });
    expect(report.notes.some((note) => note.includes("validation-only"))).toBe(true);
  });

  it("writes a report and a display artifact without the raw national payload", async () => {
    await runRestrictionSmoke(
      { sourceId: "fi-digitraffic", outputDir },
      { fetch: serve(roadworks()), lookup: fakeLookup, now: () => CHECKED_AT }
    );
    const report = JSON.parse(await readFile(join(outputDir, "report.json"), "utf8"));
    expect(report.sourceId).toBe("fi-digitraffic");
    const display = await readFile(join(outputDir, "display.geojson"), "utf8");
    expect(display).not.toContain("sourceRaw");
    expect(display).not.toContain("Fintraffic Tieliikennekeskus");
    expect(display).toContain("restrictionDetails");
  });

  it("reports a restriction kind the snapshot does not contain as not observed", async () => {
    const withoutWeights = roadworks();
    withoutWeights.features = withoutWeights.features.filter(
      (feature) =>
        (feature["properties"] as Record<string, unknown>)["situationId"] === "GUID50468844"
    );
    const report = await runRestrictionSmoke(
      { sourceId: "fi-digitraffic", outputDir },
      { fetch: serve(withoutWeights), lookup: fakeLookup, now: () => CHECKED_AT }
    );
    expect(report.restrictions.kinds["height:m"]).toBe(1);
    expect(report.restrictions.kinds["gross_weight:kg"]).toBeUndefined();
    expect(report.notes).toContain("not observed in this snapshot: gross_weight:kg");
  });

  it("fails a partial acquisition rather than reporting a small feed", async () => {
    await expect(
      runRestrictionSmoke(
        { sourceId: "fi-digitraffic", outputDir },
        {
          fetch: serve(roadworks(), { failWeights: true }),
          lookup: fakeLookup,
          now: () => CHECKED_AT,
        }
      )
      // A failed partition surfaces as the transport error itself; either way
      // the run fails rather than reporting a smaller feed.
    ).rejects.toThrow(/503|acquisition/);
  });

  it("fails a malformed envelope rather than publishing a partial parse", async () => {
    const broken = (async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      return new Response(url.startsWith(ROADWORKS) ? "{not json" : JSON.stringify(EMPTY), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await expect(
      runRestrictionSmoke(
        { sourceId: "fi-digitraffic", outputDir },
        { fetch: broken, lookup: fakeLookup, now: () => CHECKED_AT }
      )
    ).rejects.toThrow();
  });

  it("fails a record with no stable identity", async () => {
    const malformed = roadworks();
    malformed.features = malformed.features.map((feature, index) =>
      index === 0
        ? { ...feature, properties: { ...(feature["properties"] as object), situationId: null } }
        : feature
    );
    await expect(
      runRestrictionSmoke(
        { sourceId: "fi-digitraffic", outputDir },
        { fetch: serve(malformed), lookup: fakeLookup, now: () => CHECKED_AT }
      )
    ).rejects.toThrow(/missing_identity/);
  });

  it("rejects an unsupported source and a missing output directory", async () => {
    await expect(
      runRestrictionSmoke({ sourceId: "nl-ndw", outputDir }, { lookup: fakeLookup })
    ).rejects.toThrow(/nl-ndw is not supported/);
    await expect(
      runRestrictionSmoke(
        { sourceId: "fi-digitraffic", outputDir: "  " },
        { fetch: serve(roadworks()), lookup: fakeLookup }
      )
    ).rejects.toThrow(/output directory/);
  });

  it("accepts a valid complete empty snapshot as an honest empty observation", async () => {
    const report = await runRestrictionSmoke(
      { sourceId: "fi-digitraffic", outputDir },
      { fetch: serve(EMPTY), lookup: fakeLookup, now: () => CHECKED_AT }
    );
    expect(report.snapshot).toMatchObject({ inputCount: 0, accepted: 0 });
    expect(report.restrictions.recordsWithDetails).toBe(0);
    expect(report.notes.some((note) => note.includes("frozen fixtures remain the gate"))).toBe(
      true
    );
  });
});
