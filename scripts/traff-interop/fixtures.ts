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
  timing: [
    {
      ...record,
      kind: "closure",
      type: "closure",
      subtype: "full",
      effects: [
        {
          ...record.effects[0],
          validity: {
            status: "planned",
            start: "2026-09-07T10:00:00Z",
            end: "2026-09-07T11:00:00Z",
          },
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

// One situation per TraFF event the registry crosswalk can name, so the reader
// sees every nature this emitter can write. The expectations file lists the
// event type each message must carry, in emission order.
const natures = new Map<string, Record<string, string>>();
for (const kind of registry.kinds("situation")) {
  for (const [type, subtypes] of Object.entries(kind.types ?? {})) {
    for (const subtype of [undefined, ...subtypes]) {
      const classification = { kind: kind.code, type, ...(subtype ? { subtype } : {}) };
      const code = registry.crosswalk.situationTargetCode("traff", classification);
      if (code !== undefined && !natures.has(code)) natures.set(code, classification);
    }
  }
}
const natureRecords = [...natures].map(([code, classification]) => ({
  ...record,
  ...classification,
  id: `oc:situation:interop:nature-${code}`,
  effects: [],
}));
await writeFile(join(output, "natures.xml"), situationsToTraff(registry, natureRecords, at));
await writeFile(join(output, "natures.txt"), `${[...natures.keys()].join("\n")}\n`);

// Every event an effect maps to, with its quantifiers and the diversion note.
// Each situation is an incident, whose nature event comes first.
const effectCases: [string, Record<string, unknown>[]][] = [
  ["closure-road", [{ kind: "closure", scope: "road" }]],
  ["closure-carriageway", [{ kind: "closure", scope: "carriageway" }]],
  ["closure-ramp", [{ kind: "closure", scope: "ramp" }]],
  ["closure-bridge", [{ kind: "closure", scope: "bridge" }]],
  ["closure-tunnel", [{ kind: "closure", scope: "tunnel" }]],
  ["lanes-all-closed", [{ kind: "lane_restriction", vehicleImpact: "all_lanes_closed" }]],
  ["lanes-some-closed", [{ kind: "lane_restriction", vehicleImpact: "some_lanes_closed" }]],
  ["lanes-unknown", [{ kind: "lane_restriction", vehicleImpact: "unknown" }]],
  ["contraflow", [{ kind: "contraflow" }]],
  ["speed-limit", [{ kind: "speed_limit", limit: { value: 59.6, unit: "km/h" } }]],
  ["delay-uncertain", [{ kind: "delay", delayType: "delays_of_uncertain_duration" }]],
  ["delay-long", [{ kind: "delay", delayType: "long_delays" }]],
  ["delay-very-long", [{ kind: "delay", delayType: "very_long_delays" }]],
  [
    "detour",
    [
      { kind: "closure", scope: "road" },
      { kind: "detour", signed: true },
    ],
  ],
];
const effectRecords = effectCases.map(([name, effects]) => ({
  ...record,
  id: `oc:situation:interop:effect-${name}`,
  kind: "incident",
  type: "accident",
  severity: { label: "critical", source: "derived" },
  temporality: "forecast",
  location: {
    ...record.location,
    roads: [
      {
        ref: "A 46",
        // Markup characters must be escaped; the control character is not
        // representable in XML 1.0 and becomes U+FFFD.
        name: [{ lang: "de", text: 'Düsseldorf <Süd> & "Nord" \u0001 ✓' }],
        class: "motorway",
        from: "AK Düsseldorf-Süd",
        to: "AS Erkrath",
      },
    ],
  },
  effects: effects.map((effect, i) => ({
    ...record.effects[0],
    id: `${name}/${i}`,
    ...effect,
  })),
}));
await writeFile(join(output, "effects.xml"), situationsToTraff(registry, effectRecords, at));
