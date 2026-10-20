import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-08-29T15:30:00Z";

/** Trafikverket's object API, asked for every camera not deleted. */
const trafikverketFeed = () =>
  cameraFeed("se", {
    operator: "trafikverket",
    product: "cameras",
    name: "Trafikverket traffic cameras",
    tier: "authoritative",
    format: "trafikverket",
    endpoints: {
      main: {
        url: "https://api.trafikinfo.trafikverket.se/v2/data.json",
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${api_key} is the catalogue's own credential placeholder, filled at fetch time, not a JavaScript template
        body: '<REQUEST><LOGIN authenticationkey="${api_key}"/><QUERY objecttype="Camera" namespace="road.infrastructure" schemaversion="1.1"><FILTER><EQ name="Deleted" value="false"/></FILTER></QUERY></REQUEST>',
        cadenceSec: 600,
      },
    },
    credentials: { api_key: { title: "API key" } },
    freshnessWindowSec: 1800,
    license: "CC0-1.0",
    attribution: "Trafikverket",
    privacyUrl:
      "https://www.trafikverket.se/om-oss/kontakta-oss/om-webbplatsen/sa-hanterar-trafikverket-dataskyddsforordningen-gdpr/",
    cameras: { imageHosts: ["api.trafikinfo.trafikverket.se"] },
  });

const parse = (body = fixture("se-trafikverket-cameras.json")): ParseOutput =>
  camerasDomain.formats["trafikverket"]!.parse(
    trafikverketFeed(),
    { main: [body] },
    parseContext(FETCHED),
  );

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:se-trafikverket-cameras:${id}`);
const reading = (out: ParseOutput, id: string) =>
  out.observations.find(
    (o) =>
      (o["subject"] as { featureId: string }).featureId ===
      `oc:feature:se-trafikverket-cameras:${id}`,
  );
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const viewDetails = (draft: RecordDraft | undefined) =>
  ((draft?.["components"] ?? []) as { details: Record<string, unknown> }[])[0]?.details;

const IMAGES = "https://api.trafikinfo.trafikverket.se/v2/Images/data/road.infrastructure.camera";

describe("trafikverket", () => {
  beforeEach(() => __resetSkips());

  test("a numeric Direction is the view's bearing, and PhotoTime is the image's time", () => {
    const out = parse();
    expect(out.features).toHaveLength(3);
    const rotebro = camera(out, "SE_STA_CAMERA_Orion_387");
    expect(rotebro).toMatchObject({
      type: "traffic",
      name: [{ lang: "sv", text: "Rotebro" }],
      description: [{ lang: "sv", text: "Kameran är riktad söderut längs E4." }],
      location: { geometry: { coordinates: [17.9029, 59.51146] } },
      details: { kind: "camera", v: 1, imageRedistribution: "allowed" },
    });
    expect(viewDetails(rotebro)).toEqual({
      kind: "camera_view",
      v: 1,
      bearingDeg: 180,
      imageRedistribution: "allowed",
    });
    const photo = reading(out, "SE_STA_CAMERA_Orion_387");
    expect(photo).toMatchObject({ phenomenonTime: { instant: "2026-08-29T15:22:10Z" } });
    // No full-size photo: the plain photo is the still.
    expect(value(photo)).toEqual({
      v: 1,
      status: "online",
      imageUrl: `${IMAGES}/TrafficFlowCamera_39626508.jpg`,
      imageAt: "2026-08-29T15:22:10Z",
      thumbnailUrl: `${IMAGES}/TrafficFlowCamera_39626508_thumbnail.jpg`,
    });
  });

  test("the full-size photo is the still where there is one; an inactive camera is offline", () => {
    const out = parse();
    expect(value(reading(out, "SE_STA_CAMERA_Orion_386"))).toEqual({
      v: 1,
      status: "online",
      imageUrl: `${IMAGES}/TrafficFlowCamera_39626507_fullsize.jpg`,
      imageAt: "2026-08-29T15:24:30Z",
      thumbnailUrl: `${IMAGES}/TrafficFlowCamera_39626507_thumbnail.jpg`,
    });
    expect(viewDetails(camera(out, "SE_STA_CAMERA_Orion_386"))).toEqual({
      kind: "camera_view",
      v: 1,
      bearingDeg: 40,
      imageRedistribution: "allowed",
    });
    const haggvik = reading(out, "SE_STA_CAMERA_Orion_388");
    expect(value(haggvik)?.["status"]).toBe("offline");
    // No photo time: as of the fetch.
    expect(haggvik).toMatchObject({ phenomenonTime: { instant: FETCHED } });
    expect(viewDetails(camera(out, "SE_STA_CAMERA_Orion_388"))).toEqual({
      kind: "camera_view",
      v: 1,
      imageRedistribution: "allowed",
    });
  });

  test("only Active false reads offline; a Status other than videoOrImagesAvailable is unknown", () => {
    // Trafikverket documents no Status values; the one seen in a real answer
    // is videoOrImagesAvailable, so any other value says nothing for sure.
    const doc = JSON.parse(fixture("se-trafikverket-cameras.json").toString("utf8"));
    doc.RESPONSE.RESULT[0].Camera[0].Status = "videoOrImagesUnavailableDueToCameraFault";
    doc.RESPONSE.RESULT[0].Camera[1].Status = "videoOrImagesUnavailable";
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(value(reading(out, "SE_STA_CAMERA_Orion_386"))?.["status"]).toBe("unknown");
    expect(value(reading(out, "SE_STA_CAMERA_Orion_387"))?.["status"]).toBe("unknown");
    expect(value(reading(out, "SE_STA_CAMERA_Orion_388"))?.["status"]).toBe("offline");
    // Each status left unread is counted.
    expect(drainSkipped(trafikverketFeed().id)).toEqual({ unknown_value: 2 });
  });

  test("the county, the location text and the location sketch are read", () => {
    const out = parse();
    expect(drainSkipped(trafikverketFeed().id)).toEqual({});
    const nybygget = camera(out, "SE_STA_CAMERA_Orion_386");
    // Its location repeats its description, so it is not kept twice.
    expect(nybygget?.["location"]).toMatchObject({
      admin: { country: "SE", subdivision: "SE-AB" },
    });
    expect(nybygget?.["location"]).not.toHaveProperty("areaDescription");
    expect(nybygget?.["images"]).toEqual([
      { url: `${IMAGES}/TrafficFlowCamera_39626507_sketch.jpg`, category: "other" },
    ]);
    const rotebro = camera(out, "SE_STA_CAMERA_Orion_387");
    expect(rotebro?.["location"]).toMatchObject({
      areaDescription: [{ lang: "sv", text: "E4 Rotebro" }],
    });
    expect(rotebro).not.toHaveProperty("images");
  });

  test("a Type or a CountyNo not read is counted; the camera stays a traffic camera", () => {
    // Constructed: only Trafikflödeskamera is seen in a real answer.
    const doc = JSON.parse(fixture("se-trafikverket-cameras.json").toString("utf8"));
    doc.RESPONSE.RESULT[0].Camera[0].Type = "Okänd kamera";
    doc.RESPONSE.RESULT[0].Camera[1].CountyNo = 99;
    doc.RESPONSE.RESULT[0].Camera[2].CountyNo = [1, 3];
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(drainSkipped(trafikverketFeed().id)).toEqual({ unknown_value: 2 });
    expect(camera(out, "SE_STA_CAMERA_Orion_386")?.["type"]).toBe("traffic");
    // A number that is no county, or two counties, give the country alone.
    for (const id of ["SE_STA_CAMERA_Orion_387", "SE_STA_CAMERA_Orion_388"]) {
      expect(camera(out, id)?.["location"]).toHaveProperty("admin", { country: "SE" });
    }
  });

  test("a Type naming an inherited property is an unknown value, not a camera type", () => {
    const doc = JSON.parse(fixture("se-trafikverket-cameras.json").toString("utf8"));
    doc.RESPONSE.RESULT[0].Camera[0].Type = "constructor";
    doc.RESPONSE.RESULT[0].Camera[1].Type = "toString";
    doc.RESPONSE.RESULT[0].Camera[2].Type = "__proto__";
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(drainSkipped(trafikverketFeed().id)).toEqual({ unknown_value: 3 });
    for (const id of [
      "SE_STA_CAMERA_Orion_386",
      "SE_STA_CAMERA_Orion_387",
      "SE_STA_CAMERA_Orion_388",
    ]) {
      expect(camera(out, id)?.["type"]).toBe("traffic");
    }
  });

  test("an error answer fails the parse, and a deleted camera is left out", () => {
    const error = Buffer.from(
      JSON.stringify({
        RESPONSE: { RESULT: [{ ERROR: { SOURCE: "Authentication", MESSAGE: "Invalid key" } }] },
      }),
    );
    expect(() => parse(error)).toThrow(/Invalid key/);

    const doc = JSON.parse(fixture("se-trafikverket-cameras.json").toString("utf8"));
    doc.RESPONSE.RESULT[0].Camera[0].Deleted = true;
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:se-trafikverket-cameras:SE_STA_CAMERA_Orion_387",
      "oc:feature:se-trafikverket-cameras:SE_STA_CAMERA_Orion_388",
    ]);
  });

  test("every camera and reading seals", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  test("a camera without an id or a readable point is malformed, one without a position has no geometry", () => {
    const doc = JSON.parse(fixture("se-trafikverket-cameras.json").toString("utf8"));
    const cameras = doc.RESPONSE.RESULT[0].Camera;
    delete cameras[0].Id;
    cameras[1].Geometry = { WGS84: "POINT (abc def)" };
    delete cameras[2].Geometry;
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(out.features).toEqual([]);
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(trafikverketFeed().id)).toEqual({ malformed: 2, no_geometry: 1 });
  });
});
