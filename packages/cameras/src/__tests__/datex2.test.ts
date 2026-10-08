import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { camerasDomain } from "../domain.js";
import { cameraFeed, parseContext } from "./helpers/cameras-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T07:00:00Z";

/** DGT's capture, which the datex2 package's decoder tests read too. */
const DGT = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "datex2",
    "src",
    "__tests__",
    "fixtures",
    "es-dgt-cameras.xml",
  ),
);

/** DGT's DATEX II v3.7 device publication of its traffic cameras. */
const dgtFeed = () =>
  cameraFeed("es", {
    operator: "dgt",
    product: "cameras",
    name: "DGT traffic cameras",
    tier: "authoritative",
    format: "datex2",
    endpoints: {
      main: {
        url: "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml",
        cadenceSec: 3600,
      },
    },
    freshnessWindowSec: 7200,
    license: "CC-BY-4.0",
    attribution: "Dirección General de Tráfico (DGT)",
    privacyUrl: "https://www.dgt.es/contenido/aviso-legal/",
    cameras: { imageHosts: ["etraffic.dgt.es"] },
  });

const parse = (): ParseOutput =>
  camerasDomain.formats["datex2"]!.parse(dgtFeed(), { main: [DGT] }, parseContext(FETCHED, 3600));

const camera = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:es-dgt-cameras:${id}`);
const value = (r: RecordDraft | undefined) =>
  (r?.["result"] as { value: Record<string, unknown> } | undefined)?.value;
const viewDetails = (draft: RecordDraft | undefined) =>
  ((draft?.["components"] ?? []) as { details: Record<string, unknown> }[])[0]?.details;

describe("datex2", () => {
  test("a DGT camera looks along its road reference, named for its road and destination", () => {
    const out = parse();
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:es-dgt-cameras:176130",
      "oc:feature:es-dgt-cameras:2",
      "oc:feature:es-dgt-cameras:167979",
    ]);
    const burgos = camera(out, "176130");
    expect(burgos).toMatchObject({
      type: "traffic",
      name: [{ lang: "es", text: "A-62 → BURGOS" }],
      location: {
        geometry: { coordinates: [-3.9403, 42.2624] },
        roads: [{ ref: "A-62", kmFrom: 25.3 }],
      },
      details: { kind: "camera", v: 1, imageRedistribution: "unknown" },
    });
    expect(viewDetails(burgos)).toEqual({
      kind: "camera_view",
      v: 1,
      direction: { value: "negative", basis: "road_reference" },
      imageRedistribution: "unknown",
    });
    expect(value(out.observations[0])).toEqual({
      v: 1,
      status: "unknown",
      imageUrl: "https://etraffic.dgt.es/camarasEtraffic/176130.jpg",
    });
    // The device's update time dates its record, not its image.
    expect(out.observations[0]).toMatchObject({ phenomenonTime: { instant: FETCHED } });
  });

  test("a device without a destination is named for its road; both ways stay both", () => {
    const out = parse();
    const both = camera(out, "167979");
    expect(both?.["name"]).toEqual([{ lang: "es", text: "AP-6" }]);
    expect(viewDetails(both)).toMatchObject({
      direction: { value: "both", basis: "road_reference" },
    });
  });

  test("every camera and reading seals", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });
});
