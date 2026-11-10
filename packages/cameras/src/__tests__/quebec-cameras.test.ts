import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { parseQuebecCameras } from "../formats/quebec-cameras.js";
import { catalogFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const feed = () => catalogFeed("ca-qc-mtmd-cameras");
const captured = () => JSON.parse(fixture("ca-qc-mtmd.json").toString());
const parse = (body = captured()) =>
  parseQuebecCameras(
    feed(),
    { main: [Buffer.from(JSON.stringify(body))] },
    parseContext("2026-11-07T12:00:00Z", 86400),
  );

describe("Québec metadata inventory", () => {
  test("seals bilingual metadata with exact source geometry, road and external view link", () => {
    const out = parse();
    expect(sealFailures(out.features)).toEqual([]);
    expect(out.observations).toEqual([]);
    const camera = out.features[0]!;
    expect(camera).toMatchObject({
      id: "oc:feature:ca-qc-mtmd-cameras:3998",
      location: {
        geometry: { coordinates: [-71.35488, 46.78853] },
        geometryOrigin: "source",
        roads: [{ ref: "00540" }],
      },
      provenance: { recordId: "3998", sourceFormat: "quebec-cameras" },
      description: [
        { lang: "fr", text: captured().features[0].properties.DescriptionLocalisationFr },
        { lang: "en", text: captured().features[0].properties.DescriptionLocalisationEn },
      ],
      details: {
        detailUrl: "https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3998",
        imageRedistribution: "unknown",
      },
      components: [
        {
          key: "0",
          details: {
            detailUrl: "https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3998",
            imageRedistribution: "unknown",
          },
        },
      ],
    });
    expect(camera).not.toHaveProperty("images");
    expect(camera["details"]).not.toHaveProperty("playerEmbedUrl");
    expect(camera).not.toHaveProperty("phenomenonTime");
    const reversed = captured();
    reversed.features.reverse();
    expect(parse(reversed).features.reverse()).toEqual(out.features);
  });
  test.each(["missing", "duplicate", "point", "truncated", "empty"])(
    "fails closed for %s",
    (kind) => {
      const body = captured();
      if (kind === "missing") delete body.features[0].properties.IDEcamera;
      if (kind === "duplicate")
        body.features[1].properties.IDEcamera = body.features[0].properties.IDEcamera;
      if (kind === "point") body.features[0].geometry.coordinates = [200, 46];
      if (kind === "truncated") body.features.pop();
      if (kind === "empty") {
        body.features = [];
        body.numberMatched = 0;
      }
      expect(() => parse(body)).toThrow();
    },
  );
  test("optional text remains absent", () => {
    const body = captured();
    body.features[0].properties = { IDEcamera: "3998" };
    const camera = parse(body).features[0]!;
    expect(camera).not.toHaveProperty("name");
    expect(camera).not.toHaveProperty("description");
    expect(camera["location"]).not.toHaveProperty("roads");
    expect(sealFailures([camera])).toEqual([]);
  });
});

test("catalogue policy enforces metadata-only, daily and explicit count/CRS acquisition", () => {
  const valid = feed();
  expect(camerasDomain.lintFeed?.(valid)).toEqual([]);
  for (const change of [
    { cameras: { imageRedistribution: "allowed" as const, imageHosts: ["example.com"] } },
    { snapshot: { completeness: "complete" as const, recordsPath: "features" } },
    { endpoints: { main: { url: "https://example.com/cameras", cadenceSec: 300 } } },
  ])
    expect(camerasDomain.lintFeed?.({ ...valid, ...change })).not.toEqual([]);
});
