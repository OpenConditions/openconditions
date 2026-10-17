import {
  assertCovered,
  pinnedOrUnavailable,
  type XsdEnumeration,
  xsdEnumeration,
  xsdEnumerations,
} from "@openconditions/conformance";
import { DATEX2_V3 } from "@openconditions/conformance/standards/datex2-v3";
import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { catalogFeed, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FEED = "es-dgt-cameras";
const POINT = `<pointLocation xmlns:loc="http://datex2.eu/schema/3/locationReferencing"><loc:tpegPointLocation xsi:type="loc:TpegSimplePoint"><loc:point xsi:type="loc:TpegNonJunctionPoint"><loc:pointCoordinates><loc:latitude>42.26</loc:latitude><loc:longitude>-3.94</loc:longitude></loc:pointCoordinates></loc:point></loc:tpegPointLocation></pointLocation>`;

/** A v3.7 device publication of the given devices. */
const devices = (body: string) =>
  Buffer.from(
    `<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns="http://datex2.eu/schema/3/faultAndStatus" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="DevicePublication" lang="es" modelBaseVersion="3">${body}</d2:payload>`,
  );

const device = (type: string, id = "d", point = true) =>
  `<device id="${id}" version="1"><typeOfDevice>${type}</typeOfDevice>${point ? POINT : ""}</device>`;

function parse(body: Buffer): ParseOutput {
  const out = camerasDomain.formats["datex2"]!.parse(
    catalogFeed(FEED),
    { main: [body] },
    parseContext("2026-10-08T05:30:00Z", 3600),
  );
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  return out;
}

describe("DATEX II v3.7 devices through the camera parser", () => {
  let enums: XsdEnumeration[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_V3);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else enums = xsdEnumerations(pinned.files);
  }, 120_000);

  test("device types: a camera is a traffic camera, any other device no camera", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const types = xsdEnumeration(
      enums,
      "DeviceTypeEnum",
      "http://datex2.eu/schema/3/faultAndStatus",
    );
    assertCovered("DeviceTypeEnum", types, {
      handled: (v) => {
        const out = parse(devices(device(v)));
        return out.features.length === 1 && out.features[0]?.["type"] === "traffic";
      },
      unsupported: Object.fromEntries(
        types
          .filter((v) => v !== "camera")
          .map((v) => [
            v,
            v === "_extended"
              ? "the schema's escape hatch for national extensions"
              : "not a camera: the camera parser reads cameras only, by design",
          ]),
      ),
    });
  });
});

describe("what the DATEX camera parser leaves unread is counted", () => {
  beforeEach(() => __resetSkips());

  test("a camera without a point, or without an id, by reason; other devices are not counted", () => {
    const out = parse(
      devices(
        device("camera", "a") +
          device("camera", "b", false) +
          `<device><typeOfDevice>camera</typeOfDevice>${POINT}</device>` +
          device("vms", "v"),
      ),
    );
    expect(out.features).toHaveLength(1);
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1, malformed: 1 });
  });
});
