import { describe, expect, it } from "vitest";
import { parseTurinFlow } from "../flow-turin.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "turin-5t-flow",
  attribution: "5T / Città di Torino",
  country: "IT",
  license: "CC-BY-4.0",
} as SourceDescriptor;

const XML = `<?xml version="1.0" encoding="utf-8"?>
<traffic_data xmlns="https://simone.5t.torino.it/ns/traffic_data.xsd" generation_time="2026-07-10T18:00:03.516Z">
  <FDT_data lcd1="39983" Road_name="Corso Allamano(TO)" direction="positive" lat="45.0507" lng="7.6225" accuracy="95" period="5"><speedflow flow="360" speed="54.5"/></FDT_data>
  <FDT_data lcd1="40121" Road_name="Corso Regina Margherita(TO)" direction="positive" lat="45.096231" lng="7.625643" accuracy="0" period="5"><speedflow flow="0" speed="0"/></FDT_data>
</traffic_data>`;

describe("parseTurinFlow", () => {
  it("emits an inline-Point flow with km/h speed and drops accuracy=0 detectors", () => {
    const { flows } = parseTurinFlow(XML, src);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("turin-5t-flow:39983");
    expect(flows[0]!.sourceFormat).toBe("turin-fdt-xml");
    expect(flows[0]!.speedKph).toBe(54.5);
    expect(flows[0]!.direction).toBe("positive");
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [7.6225, 45.0507] });
    expect(flows[0]!.dataUpdatedAt).toBe("2026-07-10T18:00:03.516Z");
  });

  it("flags a hard parse failure", () => {
    expect(parseTurinFlow("not xml <", src).failed).toBe(true);
  });
});
