import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseElaboratedFlow } from "../flow-elaborated.js";
import { parsePredefinedLocations } from "../predefined-locations.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "de-hh-autobahn",
  attribution: "Quelle: Die Autobahn GmbH des Bundes",
  country: "DE",
  license: "GeoNutzV",
};

const siteMap = parsePredefinedLocations(
  readFileSync(join(import.meta.dirname, "fixtures/autobahn-bab/verortung.xml"))
);
const xml = readFileSync(join(import.meta.dirname, "fixtures/autobahn-bab/elaborated.xml"));

describe("parseElaboratedFlow", () => {
  it("emits one flow per site, joining geometry from the siteMap", () => {
    const { flows } = parseElaboratedFlow(xml, SRC, siteMap);
    expect(flows).toHaveLength(2);
    const byId = Object.fromEntries(flows.map((f) => [f.id, f]));
    expect(byId["de-hh-autobahn:MQ_A1_0042"]!.geometry).toEqual({
      type: "Point",
      coordinates: [10.0574, 53.60864],
    });
  });

  it("carries speed (v), volume (q) and derives los from trafficStatus", () => {
    const { flows } = parseElaboratedFlow(xml, SRC, siteMap);
    const a1 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A1_0042")!;
    expect(a1.speedKph).toBe(48);
    expect(a1.volume).toBe(1800);
    expect(a1.los).toBe("heavy");
    expect(a1.sourceFormat).toBe("datex-elaborated");
  });

  it("emits a congestion event when los is queuing or worse (none here at 'heavy')", () => {
    const { events } = parseElaboratedFlow(xml, SRC, siteMap);
    expect(events).toHaveLength(0);
  });

  it("hard-fails on a non-ElaboratedData document", () => {
    const res = parseElaboratedFlow("<foo/>", SRC, siteMap);
    expect(res.failed).toBe(true);
  });

  it("maps a DATEX 'congested' TrafficStatus to queuing los and a congestion event", () => {
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="ElaboratedDataPublication">
    <elaboratedData>
      <basicData xsi:type="TrafficStatus">
        <trafficStatus><trafficStatusValue>congested</trafficStatusValue></trafficStatus>
        <pertinentLocation xsi:type="Location">
          <predefinedLocationReference id="MQ_A1_0042"/>
        </pertinentLocation>
      </basicData>
    </elaboratedData>
  </payloadPublication>
</d2LogicalModel>`;
    const { flows, events } = parseElaboratedFlow(doc, SRC, siteMap);
    const a1 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A1_0042")!;
    expect(a1.los).toBe("queuing");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("congestion");
  });

  it("reads a plain-text leaf trafficStatus (the DATEX v2 enum-member form)", () => {
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="ElaboratedDataPublication">
    <elaboratedData>
      <basicData xsi:type="TrafficStatus">
        <trafficStatus>congested</trafficStatus>
        <pertinentLocation xsi:type="Location">
          <predefinedLocationReference id="MQ_A1_0042"/>
        </pertinentLocation>
      </basicData>
    </elaboratedData>
  </payloadPublication>
</d2LogicalModel>`;
    const { flows } = parseElaboratedFlow(doc, SRC, siteMap);
    const a1 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A1_0042")!;
    expect(a1.los).toBe("queuing");
  });

  it("ignores a dataError-flagged volume so an invalid rate is never published", () => {
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="ElaboratedDataPublication">
    <elaboratedData>
      <basicData xsi:type="TrafficSpeed">
        <averageVehicleSpeed numberOfInputValuesUsed="20"><speed>48</speed></averageVehicleSpeed>
        <pertinentLocation xsi:type="Location">
          <predefinedLocationReference id="MQ_A1_0042"/>
        </pertinentLocation>
      </basicData>
    </elaboratedData>
    <elaboratedData>
      <basicData xsi:type="TrafficFlow">
        <vehicleFlow><dataError>true</dataError><vehicleFlowRate>9999</vehicleFlowRate></vehicleFlow>
        <pertinentLocation xsi:type="Location">
          <predefinedLocationReference id="MQ_A1_0042"/>
        </pertinentLocation>
      </basicData>
    </elaboratedData>
  </payloadPublication>
</d2LogicalModel>`;
    const { flows } = parseElaboratedFlow(doc, SRC, siteMap);
    const a1 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A1_0042")!;
    expect(a1.speedKph).toBe(48);
    expect(a1.volume).toBeUndefined();
  });
});

describe("parseElaboratedFlow — Verkehrslage (TrafficStatus only)", () => {
  const losSiteMap = parsePredefinedLocations(
    readFileSync(join(import.meta.dirname, "fixtures/autobahn-bab/verortung.xml"))
  );
  const losXml = readFileSync(join(import.meta.dirname, "fixtures/autobahn-bab/verkehrslage.xml"));

  it("emits los-only flows (no speed) with los from the declared status", () => {
    const { flows } = parseElaboratedFlow(losXml, SRC, losSiteMap);
    const a1 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A1_0042")!;
    expect(a1.speedKph).toBeUndefined();
    expect(a1.los).toBe("queuing"); // congested → queuing
    const a7 = flows.find((f) => f.id === "de-hh-autobahn:MQ_A7_0100")!;
    expect(a7.los).toBe("free_flow");
  });

  it("derives a congestion event for the queuing site only", () => {
    const { events } = parseElaboratedFlow(losXml, SRC, losSiteMap);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("congestion");
  });
});
