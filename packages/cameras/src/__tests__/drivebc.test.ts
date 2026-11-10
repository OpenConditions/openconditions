import { describe, expect, test } from "vitest";
import { parseLayout } from "../formats/layout.js";
import { cameraFeed, catalogFeed, fixture, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const feed = () =>
  cameraFeed("ca", {
    privacyUrl: "https://www2.gov.bc.ca/gov/content/home/privacy",
    subdivision: "bc",
    operator: "drivebc",
    product: "cameras",
    name: "DriveBC",
    tier: "authoritative",
    format: "csv",
    endpoints: { main: { url: "https://example.org/inventory.csv", cadenceSec: 86400 } },
    freshnessWindowSec: 172800,
    license: "LicenseRef-OGL-BC",
    attribution:
      "Contains information licensed under the Open Government Licence – British Columbia.",
    layout: { lon: "longitude", lat: "latitude" },
    cameras: {
      groupBy: "cam_group",
      viewKey: "id",
      rejectConflictingViews: true,
      lang: "en",
      type: "traffic",
      imageUrl: "links_imageURL",
      detailUrl: "links_camDetailsPage",
      credit: "credit",
      imageHosts: ["www.drivebc.ca/images/"],
      imageRedistribution: "allowed",
    },
  });
const header = "id,cam_group,longitude,latitude,links_imageURL,links_camDetailsPage,credit\n";
const row = (id: number, credit = "") =>
  `${id},32,-123,49,https://www.drivebc.ca/images/${id}.jpg,https://www.drivebc.ca/cameras/${id},${credit}\n`;
describe("per-view catalogue credits", () => {
  test("keeps the row's page and plain credit on each view and image provenance", () => {
    const out = parseLayout(
      feed(),
      { main: [Buffer.from(header + row(1) + row(2, "Imagery &amp; power: <b>Capilano</b>"))] },
      parseContext("2026-11-07T00:00:00Z"),
    );
    expect(out.features[0]?.components).toMatchObject([
      { details: { detailUrl: "https://www.drivebc.ca/cameras/1" } },
      {
        details: {
          detailUrl: "https://www.drivebc.ca/cameras/2",
          credit: "Imagery & power: Capilano",
        },
      },
    ]);
    expect(out.observations[1]?.provenance).toMatchObject({
      attribution: {
        publisher: { name: "Imagery & power: Capilano", url: "https://www.drivebc.ca/cameras/2" },
      },
    });
    expect(out.observations[0]?.result).toMatchObject({ value: { status: "unknown" } });
    expect(JSON.stringify(out)).not.toContain('"imageAt"');
  });
  test("decodes each credit entity only once", () => {
    const out = parseLayout(
      feed(),
      { main: [Buffer.from(header + row(1, "&amp;lt;b&amp;gt; &amp;quot; &amp;#39;"))] },
      parseContext("2026-11-07T00:00:00Z"),
    );
    expect(out.features[0]?.components).toMatchObject([
      { details: { credit: "&lt;b&gt; &quot; &#39;" } },
    ]);
    expect(out.observations[0]?.provenance).toMatchObject({
      attribution: { publisher: { name: "&lt;b&gt; &quot; &#39;" } },
    });
  });
  test("row order and identical repeats preserve view identity, and unsafe images are dropped", () => {
    const parse = (body: string) =>
      parseLayout(
        feed(),
        { main: [Buffer.from(header + body)] },
        parseContext("2026-11-07T00:00:00Z"),
      );
    const first = parse(row(1) + row(2));
    expect(parse(row(2) + row(1))).toEqual(first);
    expect(parse(row(1) + row(1) + row(2))).toEqual(first);
    const rejected = parse(row(1).replace("/images/1.jpg", "/archive/1.jpg"));
    expect(rejected.observations[0]?.result).toMatchObject({ value: { status: "unknown" } });
    expect(JSON.stringify(rejected.observations)).not.toContain("archive");
    expect(parse(row(1).replace(",-123,49,", ",bad,49,")).features).toEqual([]);
  });
  test("conflicting duplicate views fail rather than selecting a row by order", () => {
    expect(() =>
      parseLayout(
        feed(),
        { main: [Buffer.from(header + row(1) + row(1, "different"))] },
        parseContext("2026-11-07T00:00:00Z"),
      ),
    ).toThrow(/conflicting/);
  });
});

test("bounded real Ministry inventory seals with unknown image age", () => {
  const actual = catalogFeed("ca-bc-drivebc-cameras");
  const bytes = fixture("ca-bc-drivebc.csv");
  const parse = (body: Buffer) =>
    parseLayout(actual, { main: [body] }, parseContext("2026-11-07T00:00:00Z"));
  const out = parse(bytes);
  expect(out.features.length).toBeGreaterThan(20);
  expect(out.observations).toHaveLength(61);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  for (const observation of out.observations) {
    expect(observation.result).toMatchObject({ value: { status: "unknown" } });
    expect(JSON.stringify(observation.result)).not.toContain('"imageAt"');
  }
});
