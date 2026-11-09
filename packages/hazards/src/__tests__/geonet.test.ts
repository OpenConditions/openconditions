import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GEONET_ID,
  geonetAddSolution,
  geonetDraft,
  geonetFeatures,
  geonetRevision,
  geonetSelect,
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
  it.each([["best"], ["deleted"], {}, null, 1])(
    "rejects a non-string discovery quality %j",
    (quality) => {
      const f = newest();
      props(f)["quality"] = quality;
      expect(() =>
        geonetFeatures(Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [f] }))),
      ).toThrow("quality");
    },
  );
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
    expect(xml[0]).toMatchObject({
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

describe("GeoNet XML revision ordering", () => {
  it("preserves preferred references and component clocks", () => {
    const s = geonetSolutions(body("event.xml"))[0]!;
    expect(s.preferredOrigin).toBe("smi:nz.org.geonet/Origin/20261106200544.993381.24606");
    expect(s.preferredMagnitude).toBe("smi:nz.org.geonet/Magnitude/20261106200610.51543.24633");
    expect(s.clocks.event.modified).toBe("2026-11-06T20:06:22.536381Z");
  });
  it("orders classification transitions in both directions regardless of duplicate order", () => {
    const older = geonetSolutions(body("event.xml"))[0]!;
    for (const type of ["earthquake", "quarry blast"]) {
      const a = structuredClone(older);
      a.type = type === "earthquake" ? "quarry blast" : "earthquake";
      const b = structuredClone(older);
      b.type = type;
      b.clocks.event.modified = "2026-11-07T10:00:00Z";
      expect(geonetSelect(a, b)).toEqual(b);
      expect(geonetSelect(b, a)).toEqual(b);
    }
  });
  it("rejects conflicting equal or absent event clocks and unordered preferred magnitudes", () => {
    const a = geonetSolutions(body("event.xml"))[0]!;
    const b = structuredClone(a);
    b.magnitude = { value: 4, scale: "Mw" };
    b.preferredMagnitude = "smi:nz.org.geonet/other";
    for (const [x, y] of [
      [a, b],
      [b, a],
    ])
      expect(() => geonetSelect(x, y)).toThrow();
    b.clocks.event.modified = "2026-11-07T10:00:00Z";
    expect(() => geonetSelect(a, b)).toThrow();
    b.clocks.magnitude = { created: "2026-11-07T09:59:00Z" };
    expect(geonetSelect(a, b)).toEqual(b);
    expect(geonetSelect(b, a)).toEqual(b);
    a.clocks.event = {};
    b.clocks.event = {};
    expect(() => geonetSelect(a, b)).toThrow();
  });
});

describe("GeoNet supplied values are validated before terminal handling", () => {
  it.each(["depth", "mmi", "magnitude", "modificationTime"])(
    "rejects invalid supplied %s on deleted records",
    (key) => {
      const f = newest();
      props(f)["quality"] = "deleted";
      props(f)[key] = "broken";
      expect(() => geonetDraft(feed(), f, undefined, AT)).toThrow();
    },
  );
  it.each([
    ["<evaluationMode>manual</evaluationMode>", "<evaluationMode>unknown</evaluationMode>"],
    ["<preferredOriginID>", "<preferredOriginID>broken-"],
    ["<type>earthquake</type>", "<type>unknown</type>"],
    ["<depth><value>", "<depth><value>bad"],
  ])("rejects semantic XML corruption of %s", (from, to) => {
    expect(() =>
      geonetSolutions(Buffer.from(body("event.xml").toString().replaceAll(from, to))),
    ).toThrow();
  });
});

it("rejects conflicting older duplicate ties in every arrival order", () => {
  const a = geonetSolutions(body("event.xml"))[0]!;
  const b = structuredClone(a);
  b.type = "quarry blast";
  const c = structuredClone(a);
  c.clocks.event.modified = "2026-11-07T10:00:00Z";
  for (const order of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ]) {
    expect(() => {
      const candidates = new Map();
      for (const s of order) geonetAddSolution(candidates, s, AT);
    }).toThrow();
  }
});

it("omits a magnitude with absent type but rejects a supplied invalid type", () => {
  const xml = body("event.xml").toString();
  expect(
    geonetSolutions(Buffer.from(xml.replaceAll("<type>MLv</type>", "")))[0],
  ).not.toHaveProperty("magnitude");
  expect(() =>
    geonetSolutions(Buffer.from(xml.replaceAll("<type>MLv</type>", "<type/>"))),
  ).toThrow();
});

it("rejects conflicting history ties with equivalent clock spellings", () => {
  const a = newest(),
    b = newest();
  props(a)["modificationTime"] = "2026-11-07T10:00:00Z";
  props(b)["modificationTime"] = "2026-11-07T10:00:00.000Z";
  props(b)["quality"] = "deleted";
  expect(() => geonetRevision(a, [b], AT)).toThrow();
});

it("compares persisted preferred solutions independently of JSON object key order", () => {
  const solution = geonetSolutions(body("event.xml"))[0]!;
  const reorder = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(reorder)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .reverse()
              .map(([k, x]) => [k, reorder(x)]),
          )
        : v;
  const persisted = reorder(solution) as typeof solution;
  expect(() => geonetSelect(persisted, solution)).not.toThrow();
  persisted.magnitude = { ...persisted.magnitude!, value: 9 };
  expect(() => geonetSelect(persisted, solution)).toThrow("Incomparable");
});

it("joins the captured preferred-magnitude update without changing the event clock", () => {
  const current = geonetRevision(
    geonetFeatures(body("component-clock-detail.geojson"))[0]!,
    geonetFeatures(body("component-clock-history.geojson")),
    "2026-11-09T10:00:54.987Z",
  );
  const solution = geonetSolutions(body("component-clock.xml"))[0]!;
  expect(props(current)["modificationTime"]).toBe("2026-11-08T21:30:01.678Z");
  expect(solution.clocks.event.modified).toBe("2026-11-08T21:29:52.729711Z");
  expect(solution.clocks.magnitude.modified).toBe("2026-11-08T21:30:01.678579Z");
  expect(geonetDraft(feed(), current, solution, "2026-11-09T10:00:54.987Z")).toHaveProperty(
    "provenance.sourceUpdatedAt",
    "2026-11-08T21:30:01.678Z",
  );
});

it("orders a preferred magnitude update independently but rejects changed classification and regressed origin", () => {
  const a = geonetSolutions(body("component-clock.xml"))[0]!;
  const b = structuredClone(a);
  b.clocks.magnitude.modified = "2026-11-08T21:30:02.678579Z";
  b.magnitude!.value += 0.1;
  expect(geonetSelect(a, b)).toBe(b);
  expect(geonetSelect(b, a)).toBe(b);
  const classified = structuredClone(b);
  classified.type = "quarry blast";
  expect(() => geonetSelect(a, classified)).toThrow();
  const regressed = structuredClone(b);
  regressed.clocks.origin.modified = "2026-11-08T21:29:51Z";
  expect(() => geonetSelect(a, regressed)).toThrow();
  const tied = structuredClone(a);
  tied.magnitude!.value += 0.1;
  expect(() => geonetSelect(a, tied)).toThrow();
});
it("canonicalizes equivalent instants without collapsing distinct microsecond revisions", () => {
  const a = geonetSolutions(body("event.xml"))[0]!;
  const b = structuredClone(a);
  b.time += "";
  b.clocks.event.modified = "2026-11-06T20:06:22.536381000Z";
  expect(geonetSelect(a, b)).toBe(a);
  b.clocks.event.modified = "2026-11-06T20:06:22.536382Z";
  expect(geonetSelect(a, b)).toBe(b);
});
it("rejects stale API information and mismatched high precision rather than rounding revisions away", () => {
  const current = geonetRevision(
    geonetFeatures(body("component-clock-detail.geojson"))[0]!,
    geonetFeatures(body("component-clock-history.geojson")),
    "2026-11-09T10:00:54.987Z",
  );
  const solution = geonetSolutions(body("component-clock.xml"))[0]!;
  for (const time of [
    "2026-11-08T21:29:52.729Z",
    "2026-11-08T21:30:01.678580Z",
    "2026-11-08T21:30:01Z",
  ]) {
    props(current)["modificationTime"] = time;
    expect(() => geonetDraft(feed(), current, solution, "2026-11-09T10:00:54.987Z")).toThrow(
      "revision conflict",
    );
  }
  props(current)["modificationTime"] = "2026-11-08T21:30:01.678579000Z";
  expect(geonetDraft(feed(), current, solution, "2026-11-09T10:00:54.987Z")).not.toBeNull();
});

it("ignores clocks of an unselected magnitude and rejects a missing selected clock", () => {
  const current = geonetRevision(
    geonetFeatures(body("component-clock-detail.geojson"))[0]!,
    geonetFeatures(body("component-clock-history.geojson")),
    "2026-11-09T10:00:54.987Z",
  );
  const raw = body("component-clock.xml").toString();
  const extra = `<magnitude publicID="smi:nz.org.geonet/unselected"><mag><value>9</value></mag><type>Mw</type><creationInfo><creationTime>2026-11-09T09:00:00Z</creationTime></creationInfo></magnitude>`;
  const solution = geonetSolutions(Buffer.from(raw.replace("</event>", extra + "</event>")))[0]!;
  expect(geonetDraft(feed(), current, solution, "2026-11-09T10:00:54.987Z")).not.toBeNull();
  solution.clocks.magnitude = {};
  expect(() => geonetDraft(feed(), current, solution, "2026-11-09T10:00:54.987Z")).toThrow(
    "revision conflict",
  );
});
