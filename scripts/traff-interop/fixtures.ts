import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productionRegistry } from "@openconditions/model-registry";
import { situationsToTraff } from "../../packages/publishers/src/situation-traff.js";

const output = process.argv[2];
if (!output) throw new Error("usage: tsx scripts/traff-interop/fixtures.ts <output-directory>");
const record = {
  id: "oc:situation:interop:line",
  class: "situation",
  kind: "roadworks",
  type: "works",
  temporality: "live",
  validity: {
    status: "active",
    start: "2026-09-06T08:00:00.000Z",
    end: "2026-09-07T08:00:00.000Z",
  },
  effects: [
    {
      id: "closure",
      kind: "closure",
      v: 1,
      scope: "road",
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    },
  ],
  location: {
    geometry: {
      type: "LineString",
      coordinates: [
        [6.805, 51.2],
        [6.818, 51.2],
      ],
    },
    direction: { value: "both", basis: "text", text: "BOTH" },
  },
  provenance: { sourceUpdatedAt: "2026-09-06T11:00:00.123+02:00" },
  freshness: { fetchedAt: "2026-09-06T09:30:00.000Z" },
};
const registry = productionRegistry();
const at = new Date("2026-09-06T10:00:00Z");
const feeds = {
  line: [record],
  point: [
    {
      ...record,
      id: "oc:situation:interop:point",
      location: {
        ...record.location,
        geometry: { type: "Point", coordinates: [6.805, 51.2] },
      },
    },
  ],
  delays: [
    {
      ...record,
      effects: [
        {
          ...record.effects[0],
          id: "short-delay",
          kind: "delay",
          delay: { value: 600, unit: "s" },
          queueLength: { value: 2400, unit: "m" },
        },
        {
          ...record.effects[0],
          id: "long-delay",
          kind: "delay",
          delay: { value: 5400, unit: "s" },
        },
      ],
    },
  ],
  empty: [],
  withheld: [
    {
      ...record,
      location: {
        ...record.location,
        direction: { value: "unknown", basis: "text", text: "unresolved carriageway" },
      },
    },
  ],
  bulk: Array.from({ length: 5001 }, (_, i) => ({
    ...record,
    id: `oc:situation:interop:item-${i}`,
  })),
};
for (const [name, records] of Object.entries(feeds)) {
  await writeFile(join(output, `${name}.xml`), situationsToTraff(registry, records, at));
}
