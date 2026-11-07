import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GEONET_ID,
  geonetDraft,
  geonetFeatures,
  geonetRevision,
  geonetSolutions,
  parseGeonet,
} from "../formats/geonet.js";
import { catalogFeed } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const body = (name: string) => readFileSync(new URL(`./fixtures/geonet/${name}`, import.meta.url));
const feed = () => catalogFeed("nz-geonet-quakes");
const AT = "2026-11-07T12:00:00Z";
const history = () => geonetFeatures(body("history.geojson"));
const newest = () => history()[0]!;
const props = (f: Record<string, unknown>) => f["properties"] as Record<string, unknown>;

describe("GeoNet exact authority and preferred solutions", () => {
  it("retains the exact bounded capture bytes and named extras policy", () => {
    const receipt = JSON.parse(body("captures.json").toString("utf8"));
    for (const capture of receipt.captures) {
      expect(createHash("sha256").update(body(capture.file)).digest("hex")).toBe(capture.sha256);
      expect(body(capture.file).length).toBe(capture.bytes);
    }
    expect(feed().extrasAllow).toEqual(["geonetQuality", "geonetLocality", "geonetLocalityMmi"]);
  });
  it("omits absent optional measurements rather than manufacturing zero", () => {
    const f = newest();
    props(f)["depth"] = null;
    props(f)["magnitude"] = null;
    props(f)["mmi"] = null;
    const d = geonetDraft(feed(), f, undefined, AT)!;
    expect(d).not.toHaveProperty("details.depth");
    expect(d).not.toHaveProperty("details.magnitude");
    expect(d).not.toHaveProperty("extras.geonetLocalityMmi");
  });
  it("uses the precise preferred XML origin and typed magnitude, not another solution", () => {
    const xml = geonetSolutions(body("event.xml"));
    expect(xml).toHaveLength(1);
    expect(xml[0]).toEqual({
      id: "2026p837394",
      type: "earthquake",
      time: "2026-11-06T20:03:41.541356Z",
      point: [176.9921112060547, -38.02727127075195],
      depth: 3969.5246219635,
      magnitude: { value: 2.1407037605271118, scale: "MLv" },
      reviewed: true,
    });
    const draft = geonetDraft(feed(), newest(), xml[0], AT)!;
    expect(draft).toMatchObject({
      id: "oc:situation:nz-geonet-quakes:2026p837394",
      externalIds: [{ scheme: "geonet:event", id: "2026p837394" }],
      provenance: { sourceUpdatedAt: "2026-11-06T20:06:22.536Z" },
      freshness: { fetchedAt: AT, expiresAt: "2026-11-09T20:03:41.541Z" },
      details: {
        magnitude: { value: 2.1407037605271118, scale: "MLv" },
        depth: { value: 3969.5246219635, unit: "m" },
        reviewed: true,
      },
      extras: { geonetQuality: "best", geonetLocalityMmi: 3 },
    });
    expect(draft["details"]).not.toHaveProperty("mmi");
    expect(sealFailures([draft])).toEqual([]);
  });
  it("selects history by modification time regardless of response order", () => {
    const h = history();
    const f = newest();
    delete props(f)["modificationTime"];
    expect(props(geonetRevision(f, h, AT))["modificationTime"]).toBe("2026-11-06T20:06:22.536Z");
    expect(geonetRevision(f, [...h].reverse(), AT)).toEqual(geonetRevision(f, h, AT));
    expect(geonetRevision(f, [], AT)).toBe(f);
  });
  it("does not let older history override a newer dated detail", () => {
    const detail = newest();
    props(detail)["modificationTime"] = "2026-11-07T10:00:00Z";
    expect(geonetRevision(detail, history(), AT)).toEqual(detail);
  });
  it.each(["best", "automatic", "preliminary"])(
    "keeps %s quality without inventing review, scale or source clock",
    (quality) => {
      const f = newest();
      props(f)["quality"] = quality;
      delete props(f)["modificationTime"];
      props(f)["mmi"] = -1;
      const d = geonetDraft(feed(), f, undefined, AT)!;
      expect(d["details"]).not.toHaveProperty("reviewed");
      expect(d["details"]).not.toHaveProperty("magnitude");
      expect(d["details"]).toMatchObject({ depth: { value: 3969.524621963501, unit: "m" } });
      expect(d["extras"]).toEqual({
        geonetQuality: quality,
        geonetLocality: "5 km south of Whakatane",
      });
      expect(d["provenance"]).not.toHaveProperty("sourceUpdatedAt");
    },
  );
  it("accepts historical numeric IDs and preserves identity across changed origin/depth/MMI", () => {
    expect(GEONET_ID.test("12345")).toBe(true);
    expect(GEONET_ID.test("1234567")).toBe(true);
    const a = newest();
    const b = newest();
    props(b)["time"] = "2026-11-06T20:03:42Z";
    props(b)["depth"] = 10;
    props(b)["mmi"] = 2;
    const da = geonetDraft(feed(), a, undefined, AT)!;
    const db = geonetDraft(feed(), b, undefined, AT)!;
    expect(db["id"]).toBe(da["id"]);
    expect(db["details"]).toMatchObject({ depth: { value: 10000, unit: "m" } });
    expect(db["extras"]).toHaveProperty("geonetLocalityMmi", 2);
  });
  it("explicit deletion is terminal even without geometry", () => {
    const f = newest();
    props(f)["quality"] = "deleted";
    f["geometry"] = null;
    expect(geonetDraft(feed(), f, undefined, AT)).toBeNull();
  });
  it("refuses malformed geometry, missing identity/time and mismatched enrichment", () => {
    const f = newest();
    f["geometry"] = { type: "Point", coordinates: [200, -38] };
    expect(() => geonetDraft(feed(), f, undefined, AT)).toThrow();
    const missing = newest();
    delete props(missing)["time"];
    expect(() => geonetDraft(feed(), missing, undefined, AT)).toThrow();
    expect(() =>
      geonetDraft(feed(), newest(), { ...geonetSolutions(body("event.xml"))[0]!, id: "12345" }, AT),
    ).toThrow();
  });
  it("fails closed for an unacquired recent list and malformed XML", () => {
    expect(() =>
      parseGeonet(
        feed(),
        { recent: [body("history.geojson")] },
        { fetchedAt: AT, cadenceSec: 600, reference: {} },
      ),
    ).toThrow();
    expect(() => geonetSolutions(Buffer.from("<quakeml>"))).toThrow();
  });
});
