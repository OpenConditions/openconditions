import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import { parseCarsSigns } from "../cars-signs.js";
import { roadsDomain } from "../domain.js";
import type { RoadFeed } from "../feed-schema.js";

const FETCHED = "2026-10-14T07:00:00Z";

const feed = {
  id: "us-ny-511-signs",
  format: "cars-signs",
  region: "us",
  product: "signs",
  attribution: "511NY / New York State DOT",
  license: "LicenseRef-511NY-DAA",
  licenseUrl: "https://511ny.org/help/24",
} as unknown as RoadFeed;

const parse = () =>
  parseCarsSigns(
    feed,
    { main: [readFileSync(join(import.meta.dirname, "fixtures/cars-ny/signs.json"))] },
    { fetchedAt: FETCHED, cadenceSec: 300, reference: {} },
  );

const registry = buildRegistry([kernelModule, roadsModule]);
const sealFailures = (drafts: readonly Record<string, unknown>[]) =>
  drafts.flatMap((d) => {
    const sealed = sealRecord(registry, d, {
      instanceId: "roads.example",
      revision: 1,
      recordedAt: FETCHED,
    });
    return sealed.ok ? [] : [{ id: d["id"], issues: sealed.issues }];
  });

const display = (o: Record<string, unknown>) =>
  (o["result"] as { value: Record<string, unknown> }).value;

describe("cars-signs", () => {
  it("is the roads domain's sign format", () => {
    expect(roadsDomain.formats["cars-signs"]).toMatchObject({
      kind: "features",
      products: ["signs"],
      produces: { kinds: ["vms", "sign_face"], properties: ["vms.display"] },
    });
  });

  it("reads each placed sign as a vms feature with one face and its display", () => {
    const out = parse();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.rejected).toBe(1);
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:us-ny-511-signs:nySigns:Sample:_S-101",
      "oc:feature:us-ny-511-signs:nySigns:Sample:_S-102",
      "oc:feature:us-ny-511-signs:nySigns:Sample:_S-103",
    ]);
    expect(out.features[0]).toMatchObject({
      kind: "vms",
      type: "matrix",
      name: [{ lang: "en", text: "I-87 NB VMS AT EXIT 6" }],
      description: [{ lang: "en", text: "I-87 N at MP 6.1" }],
      location: {
        geometry: { type: "Point", coordinates: [-73.79, 42.78] },
        direction: { value: "unknown", basis: "compass", compass: "N" },
      },
      components: [
        { key: "0", kind: "sign_face", details: { vmsIndex: 0, textRows: 3, charsPerRow: 16 } },
      ],
    });
  });

  it("shows a message's pages line by line, a blank line kept out", () => {
    const [shown] = parse().observations;
    expect(shown).toMatchObject({
      property: "vms.display",
      subject: { featureId: "oc:feature:us-ny-511-signs:nySigns:Sample:_S-101", componentKey: "0" },
      phenomenonTime: { instant: "2026-10-13T23:02:17Z" },
    });
    expect(display(shown!)).toEqual({
      v: 1,
      workingStatus: "in_service",
      messages: [
        {
          index: 0,
          text: [
            {
              page: 1,
              lines: [[{ lang: "en", text: "CRASH AHEAD" }], [{ lang: "en", text: "EXIT 7" }]],
            },
            {
              page: 2,
              lines: [[{ lang: "en", text: "RIGHT LANE" }], [{ lang: "en", text: "CLOSED" }]],
            },
          ],
        },
      ],
    });
  });

  it("states a blank sign and a failed one with no message", () => {
    const [, blank, failed] = parse().observations;
    expect(display(blank!)).toEqual({ v: 1, workingStatus: "blank", messages: [] });
    expect(display(failed!)).toEqual({ v: 1, workingStatus: "fault", messages: [] });
  });
});
