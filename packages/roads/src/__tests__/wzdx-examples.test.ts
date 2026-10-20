import { pinnedOrUnavailable, type SchemaFile } from "@openconditions/conformance";
import { WZDX_EXAMPLES } from "@openconditions/conformance/standards/wzdx";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RoadEvent } from "../model.js";
import { situationDrafts } from "../situation/assemble.js";
import { parseWzdx } from "../wzdx.js";

/**
 * Every official WZDx example feed (pinned in `WZDX_EXAMPLES`) read through
 * the parser and the situation assembler, against what the example states.
 * The expectations are written from the examples and the specification of
 * their version, not from the parser's output: each road event's type,
 * direction, validity, lanes, worker presence, restrictions in the kernel's
 * units, relationships, and which road events make up one situation. A
 * value the parser does not read is counted, never dropped silently.
 *
 * WZDx has no device examples a road-event parser reads: the SwzDeviceFeed
 * and DeviceFeed examples describe field devices, which are not pinned.
 */

const SRC = {
  id: "wzdx-examples",
  attribution: "TestDOT",
  country: "US",
  license: "CC0-1.0",
} as const;

type Json = Record<string, unknown>;

let unavailable: string | undefined;
const files = new Map<string, string>();

beforeAll(async () => {
  for (const [version, set] of Object.entries(WZDX_EXAMPLES)) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    for (const file of pinned.files as SchemaFile[]) {
      files.set(`${version} ${file.fileName.split("/").pop()}`, file.contents);
    }
  }
}, 120_000);

beforeEach(() => __resetSkips());

/** A road event as the expectations state it; a field the event leaves out is left out. */
interface Summary {
  id: string;
  type: string;
  nature?: string;
  direction?: string;
  roads: string[];
  valid: [string | null, string | null];
  status: string;
  certainty?: string;
  position?: [boolean | undefined, boolean | undefined];
  workZoneType?: string;
  workers?: boolean;
  workerPresence?: Json;
  lanes?: string;
  effects: string[];
  related?: string[];
}

const scope = (e: Json) =>
  Array.isArray(e["laneScope"])
    ? ` lane ${(e["laneScope"] as { index: number }[]).map((l) => l.index).join(",")}`
    : "";

/** One kernel effect, in words: its kind and the values it states. */
function effectText(e: Json): string {
  switch (e["kind"]) {
    case "lane_restriction": {
      const counted =
        e["lanesTotal"] !== undefined ? ` ${e["lanesClosed"]}/${e["lanesTotal"]} closed` : "";
      return `lane_restriction ${e["vehicleImpact"]}${counted}`;
    }
    case "speed_limit": {
      const limit = e["limit"] as { value: number; unit: string };
      return `speed_limit ${limit.value} ${limit.unit}`;
    }
    case "dimension_limit": {
      const value = e["value"] as { value: number; unit: string };
      return `${e["dimension"]} ${e["operator"]} ${value.value} ${value.unit} ${e["meaning"]}${scope(e)}`;
    }
    case "access": {
      const applicability = e["applicability"] as Json;
      const classes = Array.isArray(applicability["include"])
        ? ` ${(applicability["include"] as { class: string }[]).map((c) => c.class).join(",")}`
        : "";
      return `access ${e["mode"]}${classes}${scope(e)}`;
    }
    default:
      return String(e["kind"]);
  }
}

/** The road event's record id: its id without the source's. */
const localId = (event: RoadEvent) => event.id.slice(SRC.id.length + 1);

function summarise(event: RoadEvent, effects: readonly string[]): Summary {
  const c = event.situation?.classification;
  const lanes = event.lanesAffected?.lanes;
  const out: Summary = {
    id: localId(event),
    type: event.type,
    ...(c ? { nature: [c.kind, c.type, c.subtype].filter(Boolean).join(".") } : {}),
    ...(event.direction !== undefined ? { direction: event.direction } : {}),
    roads: (event.roads ?? []).map((r) => r.name ?? ""),
    valid: [event.validFrom ?? null, event.validTo ?? null],
    status: event.status,
    ...(event.confidence !== undefined ? { certainty: event.confidence } : {}),
    ...(event.positionVerified
      ? { position: [event.positionVerified.start, event.positionVerified.end] }
      : {}),
    ...(event.workZoneType !== undefined ? { workZoneType: event.workZoneType } : {}),
    ...(event.workersPresent !== undefined ? { workers: event.workersPresent } : {}),
    ...(event.workerPresence !== undefined
      ? { workerPresence: event.workerPresence as unknown as Json }
      : {}),
    ...(lanes
      ? {
          lanes: `${event.lanesAffected!.closed}/${event.lanesAffected!.total} closed: ${lanes
            .map((l) => `${l.index} ${l.type ?? "?"} ${l.status}`)
            .join(", ")}`,
        }
      : {}),
    effects: [...effects],
    ...(event.relatedEvents
      ? { related: event.relatedEvents.map((r) => `${r.type ?? "related"} ${r.id}`) }
      : {}),
  };
  return out;
}

/**
 * An example read: each road event summarised, the situations that gather
 * more than one road event (by their record ids), and what was counted.
 */
function read(name: string): {
  events: Summary[];
  groups: Record<string, string[]>;
  skipped: Record<string, number>;
} {
  const contents = files.get(name);
  if (contents === undefined) throw new Error(`no example ${name}`);
  const events = parseWzdx(contents, SRC);
  const skipped = drainSkipped(SRC.id);
  const drafts = situationDrafts(events, { source: SRC });
  const effects = new Map<string, string[]>();
  const groups: Record<string, string[]> = {};
  for (const draft of drafts) {
    const members = new Set<string>();
    for (const e of draft["effects"] as Json[]) {
      const record = String(e["id"]).split("/")[0]!;
      members.add(record);
      effects.set(record, [...(effects.get(record) ?? []), effectText(e)]);
    }
    if (members.size > 1) {
      const own = String(draft["id"]).slice(`oc:situation:${SRC.id}:`.length);
      groups[own] = [...members];
    }
  }
  return {
    events: events.map((e) => summarise(e, effects.get(localId(e)) ?? [])),
    groups,
    skipped,
  };
}

const WORKERS_ON_SITE = ["workers_working", "workers_not_working", "mobile_equipment_moving"];

/** The road events of `scenario1_simple_*` at 4.1 and 4.2, which differ only in geometry. */
function scenario1(version: "4.1" | "4.2"): Summary[] {
  const i235 = {
    type: "roadworks",
    nature: "roadworks.works.resurfacing",
    direction: "westbound",
    roads: ["I-235"],
    valid: ["2010-01-01T14:00:00Z", "2010-01-05T23:00:00Z"] as [string, string],
    status: "active",
  };
  // Tag v4.1's examples give the position flags as strings, which are not read.
  const position: Partial<Summary> = version === "4.2" ? { position: [false, false] } : {};
  const checkedIn = {
    workers: true,
    workerPresence: {
      method: "check_in_app",
      definition: ["humans_in_right_of_way"],
      confirmedAt: "2010-01-04T15:00:00.000Z",
      confidence: "high",
    },
  };
  return [
    {
      id: "1:af2e3f51-611f-4ce0-9282-2f28ca68e62f",
      type: "roadworks",
      nature: "roadworks.works",
      direction: "northbound",
      roads: ["I-80", "I-35"],
      valid: ["2010-01-01T01:00:00Z", "2010-01-02T01:00:00Z"],
      status: "active",
      ...position,
      effects: ["lane_restriction some_lanes_closed", "speed_limit 88.514 km/h"],
    },
    {
      id: "1:edf2162b-1f5d-4ddd-a731-78fb81a22e6a",
      type: "roadworks",
      nature: "roadworks.works",
      direction: "northbound",
      roads: ["128th Street"],
      valid: ["2010-01-01T06:00:00Z", "2010-05-01T05:00:00Z"],
      status: "active",
      ...position,
      ...(version === "4.2" ? { workZoneType: "static" } : {}),
      lanes: "1/2 closed: 1 general open, 2 general closed",
      effects: [
        "lane_restriction some_lanes_closed_merge_left 1/2 closed",
        "width lte 3.048 m physical_limit lane 1",
      ],
    },
    {
      id: "2:6f57aded-7291-462e-9892-607b2b7d116c",
      ...i235,
      ...position,
      workers: false,
      ...(version === "4.1" ? { workerPresence: { definition: ["humans_in_right_of_way"] } } : {}),
      lanes:
        "1/4 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 entrance-lane open, 6 shoulder open",
      effects: ["lane_restriction some_lanes_closed 1/4 closed", "speed_limit 88.514 km/h"],
      related: ["next-in-sequence 2:8bfb0ce0-98cd-4e92-924d-f0a9d3a4ba8f"],
    },
    {
      id: "2:8bfb0ce0-98cd-4e92-924d-f0a9d3a4ba8f",
      ...i235,
      ...position,
      ...checkedIn,
      lanes:
        "1/4 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 exit-lane open, 6 shoulder open",
      effects: ["lane_restriction some_lanes_closed 1/4 closed", "speed_limit 88.514 km/h"],
      related: [
        "first-in-sequence 2:6f57aded-7291-462e-9892-607b2b7d116c",
        "next-in-sequence 2:e6c2abad-04e2-41fd-bd66-4cc41e4bb6e7",
      ],
    },
    {
      id: "2:e6c2abad-04e2-41fd-bd66-4cc41e4bb6e7",
      ...i235,
      ...position,
      ...checkedIn,
      lanes:
        "1/3 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 shoulder open",
      effects: ["lane_restriction some_lanes_closed 1/3 closed", "speed_limit 88.514 km/h"],
      related: ["first-in-sequence 2:6f57aded-7291-462e-9892-607b2b7d116c"],
    },
  ];
}

function scenario2(version: "4.1" | "4.2"): Summary[] {
  return [
    {
      id: "1:85912735-7a36-45f5-b644-41b0203ae400",
      type: "roadworks",
      nature: "roadworks.works.resurfacing",
      direction: "westbound",
      roads: ["I-80", "I-35"],
      valid: ["2010-01-01T05:57:36Z", "2010-01-05T23:00:00Z"],
      status: "active",
      certainty: "observed",
      ...(version === "4.2" ? { position: [true, true] as [boolean, boolean] } : {}),
      workers: true,
      workerPresence: { method: "wearables_present", definition: WORKERS_ON_SITE },
      // Shifted lanes stay open; the closed shoulders are no travel lanes,
      // so all three lanes are open, as `all-lanes-open-shift-right` says.
      lanes:
        "0/3 closed: 1 shoulder closed, 2 general shift_right, 3 general shift_right, 4 general shift_right, 5 shoulder closed",
      effects: ["lane_restriction all_lanes_open_shift_right 0/3 closed", "speed_limit 88.5 km/h"],
    },
  ];
}

const WZ_67890 = "1:a15f7570-b7e6-4367-8ad9-3a462eea65dd";
const DETOURS_67890 = [
  "1:cf1092ba-3b8d-4e91-81ef-daa4a98662e1",
  "1:4d151e7d-11d8-4b99-a192-51e189da0de7",
  "1:9436226a-01b0-47ff-8a13-670e87549458",
];

function scenario4(version: "4.1" | "4.2"): Summary[] {
  const detour = {
    type: "detour",
    valid: ["2010-01-01T01:03:01Z", "2010-06-30T01:00:00Z"] as [string, string],
    status: "active",
    certainty: "observed",
    effects: ["detour"],
  };
  return [
    {
      id: WZ_67890,
      type: "roadworks",
      nature: "roadworks.works.resurfacing",
      direction: "northbound",
      roads: ["I-35"],
      valid: ["2010-01-01T01:03:01Z", "2010-06-30T01:00:00Z"],
      status: "active",
      certainty: "observed",
      ...(version === "4.2" ? { position: [true, false] as [boolean, boolean] } : {}),
      workers: true,
      workerPresence: { method: "scheduled", definition: WORKERS_ON_SITE, confidence: "medium" },
      lanes: "1/2 closed: 1 shoulder open, 2 general open, 3 general closed, 4 shoulder closed",
      effects: [
        "lane_restriction some_lanes_closed 1/2 closed",
        "speed_limit 88.5 km/h",
        "width lte 3.353 m physical_limit lane 2",
      ],
      related: [`related-detour ${DETOURS_67890[0]}`],
    },
    {
      id: DETOURS_67890[0]!,
      ...detour,
      direction: "westbound",
      roads: ["F22"],
      related: [`related-work-zone ${WZ_67890}`, `next-in-sequence ${DETOURS_67890[1]}`],
    },
    {
      id: DETOURS_67890[1]!,
      ...detour,
      direction: "northbound",
      roads: ["US 69"],
      related: [
        `related-work-zone ${WZ_67890}`,
        `first-in-sequence ${DETOURS_67890[0]}`,
        `next-in-sequence ${DETOURS_67890[2]}`,
      ],
    },
    {
      id: DETOURS_67890[2]!,
      ...detour,
      direction: "eastbound",
      roads: ["IA 210"],
      related: [`related-work-zone ${WZ_67890}`, `first-in-sequence ${DETOURS_67890[0]}`],
    },
  ];
}

const DS5 = "4440eb6d-96ee-4d6e-97ea-bbe12d2caf77";
const DAYS = [
  `${DS5}:a2100c5b-58b9-4593-992d-0795bafe3d8d`,
  `${DS5}:d63ab07b-98e8-41bd-b4dd-557727320056`,
  `${DS5}:ff3f888f-7e11-4a5b-8c04-3182a459a756`,
  `${DS5}:b04c1df4-f9d0-4a63-995d-38bfd83931e9`,
];

function scenario5(version: "4.1" | "4.2"): Summary[] {
  const day = (n: number, start: string, extra: Partial<Summary>): Summary => ({
    id: DAYS[n - 1]!,
    type: "roadworks",
    nature: "roadworks.works.roadside_work",
    direction: "westbound",
    roads: ["NE 150th Avenue"],
    valid: [`2022-01-0${n}T${start}:00Z`, `2022-01-0${n}T17:00:00Z`],
    status: "active",
    lanes: "0/1 closed: 1 general open, 2 shoulder closed",
    effects: ["lane_restriction all_lanes_open 0/1 closed"],
    ...extra,
  });
  // Tag v4.1 gives only the first day's position flags as strings.
  return [
    day(1, "08:30", {
      certainty: "observed",
      ...(version === "4.2" ? { position: [true, false] as [boolean, boolean] } : {}),
      workers: true,
      workerPresence: { method: "scheduled", definition: WORKERS_ON_SITE, confidence: "medium" },
      effects: ["lane_restriction all_lanes_open 0/1 closed", "speed_limit 55 km/h"],
      related: [`next-occurrence ${DAYS[1]}`],
    }),
    day(2, "08:00", {
      position: [false, false],
      related: [`first-occurrence ${DAYS[0]}`, `next-occurrence ${DAYS[2]}`],
    }),
    day(3, "08:00", {
      position: [false, false],
      related: [`first-occurrence ${DAYS[0]}`, `next-occurrence ${DAYS[3]}`],
    }),
    day(4, "08:00", { position: [false, false], related: [`first-occurrence ${DAYS[0]}`] }),
  ];
}

/** `local_access_only_bidirectional` at 4.1, `scenario8_local_access_only_bidirectional` at 4.2. */
function localAccess(version: "4.1" | "4.2"): Summary[] {
  const beaver = {
    type: "roadworks",
    nature: "roadworks.works",
    roads: ["Beaver Avenue"],
    valid: ["2010-01-01T01:03:01Z", "2010-01-01T17:00:00Z"] as [string, string],
    status: "active",
  };
  return [
    {
      id: "1:de3de57b-33fb-40e5-a6f2-a17828f82fb9",
      ...beaver,
      direction: "northbound",
      ...(version === "4.2" ? { position: [false, false] as [boolean, boolean] } : {}),
      effects: ["lane_restriction all_lanes_open", "access local_access_only"],
    },
    {
      id: "1:defbbd71-3f7e-4ddb-99de-86a48532ae57",
      ...beaver,
      direction: "southbound",
      certainty: "observed",
      ...(version === "4.2" ? { position: [true, false] as [boolean, boolean] } : {}),
      // The bike lane carries no motor traffic.
      lanes: "0/2 closed: 1 two-way-center-turn-lane open, 2 general open, 3 bike-lane open",
      effects: [
        "lane_restriction all_lanes_open 0/2 closed",
        "access local_access_only",
        "access local_access_only lane 1",
        "access local_access_only lane 2",
        "access local_access_only lane 3",
      ],
    },
  ];
}

const EB_121388 = "1:a2183b6b-befa-48ac-b6b5-3ee5e8a806e9";
const WB_121388 = "1:62c5fa4b-11ee-45e6-a740-bc32d3b846e9";
const IA210 = {
  type: "roadworks",
  roads: ["IA 210"],
  valid: ["2010-01-01T10:00:00Z", "2010-01-01T16:00:00Z"] as [string, string],
  status: "active",
};

interface Case {
  events: Summary[];
  groups?: Record<string, string[]>;
  skipped?: Record<string, number>;
}

/** The detour scenario's one situation: the work zone, with its detour's three road events. */
const DETOUR_GROUP = { [WZ_67890]: [WZ_67890, ...DETOURS_67890] };

const V42: Record<string, Case> = {
  "scenario1_simple_linestring_example.geojson": { events: scenario1("4.2") },
  "scenario1_simple_multipoint_example.geojson": { events: scenario1("4.2") },
  "scenario2_laneshift_linestring_example.geojson": { events: scenario2("4.2") },
  "scenario3_shoulder_bidirectional_linestring_example.geojson": {
    events: [
      {
        id: EB_121388,
        ...IA210,
        nature: "roadworks.works.maintenance",
        direction: "eastbound",
        position: [false, false],
        // Only the shoulder is closed: every travel lane is open, as the
        // event's `all-lanes-open` says.
        lanes: "0/1 closed: 1 general open, 2 shoulder closed",
        effects: ["lane_restriction all_lanes_open 0/1 closed"],
        related: [`related-work-zone ${WB_121388}`],
      },
      {
        id: WB_121388,
        ...IA210,
        nature: "roadworks.works",
        direction: "westbound",
        position: [false, false],
        lanes: "0/1 closed: 1 general open, 2 shoulder open",
        effects: [
          "lane_restriction all_lanes_open 0/1 closed",
          "access no_overtaking",
          "access no_parking",
          "access no_overtaking lane 1",
          "access no_parking lane 2",
        ],
        related: [`related-work-zone ${EB_121388}`],
      },
    ],
  },
  "scenario4_detour_linestring_example.geojson": {
    events: scenario4("4.2"),
    groups: DETOUR_GROUP,
  },
  "scenario5_recurring_linestring_example.geojson": { events: scenario5("4.2") },
  "scenario6_multi_lane_closure_linestring_example.geojson": {
    events: [
      {
        id: "1:8fed746d-8f4f-4e0c-8d9b-fa4db7c3c2d8",
        type: "roadworks",
        nature: "roadworks.works.resurfacing",
        direction: "westbound",
        roads: ["I-80"],
        valid: ["2010-01-02T08:00:00Z", "2010-03-31T23:00:00Z"],
        status: "active",
        position: [true, false],
        workers: true,
        workerPresence: {
          method: "camera_monitoring",
          definition: ["workers_working"],
          confirmedAt: "2010-01-03T01:51:43.000Z",
          confidence: "low",
        },
        lanes:
          "2/3 closed: 1 shoulder closed, 2 general closed, 3 general closed, 4 general open, 5 shoulder open",
        // 16 ft is 4.8768 m; 156,000 lb is 70,760.41 kg.
        effects: [
          "lane_restriction some_lanes_closed 2/3 closed",
          "speed_limit 88.5 km/h",
          "width lte 4.877 m physical_limit",
          "gross_weight lte 70760.41 kg maximum_permitted",
        ],
      },
    ],
  },
  "scenario7_mobileoperation_linestring_example.geojson": {
    events: [
      {
        id: "1:01841847-3cda-4aa8-a283-1b4a11f31c08",
        type: "roadworks",
        nature: "roadworks.works.maintenance",
        direction: "northbound",
        roads: ["I-35"],
        valid: ["2022-09-13T13:00:00Z", "2022-09-13T21:00:00Z"],
        status: "active",
        position: [false, false],
        workZoneType: "area",
        lanes: "1/2 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 shoulder open",
        effects: ["lane_restriction some_lanes_closed 1/2 closed"],
        related: ["active-moving-operation 1:71a97769-6c61-41a8-bbfd-0d84e0d073e6"],
      },
      {
        id: "1:71a97769-6c61-41a8-bbfd-0d84e0d073e6",
        type: "roadworks",
        nature: "roadworks.works.maintenance",
        direction: "northbound",
        roads: ["I-35"],
        valid: ["2022-09-13T13:00:00Z", "2022-09-13T21:00:00Z"],
        status: "active",
        position: [true, true],
        workZoneType: "moving",
        lanes: "1/2 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 shoulder open",
        effects: ["lane_restriction some_lanes_closed 1/2 closed"],
        related: ["planned-moving-operation 1:01841847-3cda-4aa8-a283-1b4a11f31c08"],
      },
    ],
  },
  "scenario8_local_access_only_bidirectional_linestring_example.geojson": {
    events: localAccess("4.2"),
  },
};

/**
 * Tag v4.1's examples are 4.2's but for their string position flags (two per
 * work zone, each counted unread), the 4.2 work zone type and lanes 4.2
 * corrected in the bidirectional shoulder scenario.
 */
const V41: Record<string, Case> = {
  "scenario1_simple_linestring_example.geojson": {
    events: scenario1("4.1"),
    skipped: { unknown_value: 10 },
  },
  "scenario1_simple_multipoint_example.geojson": {
    events: scenario1("4.1"),
    skipped: { unknown_value: 10 },
  },
  "scenario2_laneshift_linestring_example.geojson": {
    events: scenario2("4.1"),
    skipped: { unknown_value: 2 },
  },
  "scenario3_shoulder_bidirectional_linestring_example.geojson": {
    events: [
      {
        id: EB_121388,
        ...IA210,
        nature: "roadworks.works.maintenance",
        direction: "eastbound",
        lanes: "1/2 closed: 1 general closed, 2 general open, 3 shoulder closed",
        effects: ["lane_restriction all_lanes_open 1/2 closed"],
        related: [`related-work-zone ${WB_121388}`],
      },
      {
        id: WB_121388,
        ...IA210,
        nature: "roadworks.works",
        direction: "westbound",
        lanes: "1/2 closed: 1 general closed, 2 general open, 3 shoulder open",
        effects: [
          "lane_restriction all_lanes_open 1/2 closed",
          "access no_parking",
          "access no_parking lane 3",
        ],
        related: [`related-work-zone ${EB_121388}`],
      },
    ],
    skipped: { unknown_value: 4 },
  },
  "scenario4_detour_linestring_example.geojson": {
    events: scenario4("4.1"),
    groups: DETOUR_GROUP,
    skipped: { unknown_value: 2 },
  },
  "scenario5_recurring_linestring_example.geojson": {
    events: scenario5("4.1"),
    skipped: { unknown_value: 2 },
  },
  "local_access_only_bidirectional_linestring_example.geojson": {
    events: localAccess("4.1"),
    skipped: { unknown_value: 4 },
  },
};

/** 4.0's road events before 4.1 renamed their ids, and its `relationship` before `related_road_events`. */
const I235_40 = {
  type: "roadworks",
  nature: "roadworks.works.resurfacing",
  direction: "westbound",
  roads: ["I-235"],
  valid: ["2010-01-01T14:00:00Z", "2010-01-05T23:00:00Z"] as [string, string],
  status: "active",
  certainty: "likely",
  position: [false, false] as [boolean, boolean],
};

const CHECKED_IN_40 = {
  workers: true,
  workerPresence: {
    method: "check_in_app",
    definition: ["humans_in_right_of_way"],
    confirmedAt: "2010-01-04T15:00:00.000Z",
    confidence: "high",
  },
};

/**
 * 4.0's sequence names its first road event as `first` on every road event,
 * the first one included; a road event is not related to itself. Its
 * `parents` name the project `65773`, no road event of the feed.
 */
const SCENARIO1_40: Summary[] = [
  {
    id: "1:71234",
    type: "roadworks",
    nature: "roadworks.works",
    direction: "northbound",
    roads: ["I-80", "I-35"],
    valid: ["2010-01-01T01:00:00Z", "2010-01-02T01:00:00Z"],
    status: "active",
    certainty: "likely",
    position: [false, false],
    effects: ["lane_restriction some_lanes_closed", "speed_limit 88.514 km/h"],
  },
  {
    id: "1:WDM-58493-NB",
    type: "roadworks",
    nature: "roadworks.works",
    direction: "northbound",
    roads: ["128th Street"],
    valid: ["2010-01-01T06:00:00Z", "2010-05-01T05:00:00Z"],
    status: "active",
    certainty: "likely",
    position: [false, false],
    lanes: "1/2 closed: 1 general open, 2 general closed",
    effects: [
      "lane_restriction some_lanes_closed_merge_left 1/2 closed",
      "width lte 3.048 m physical_limit lane 1",
    ],
  },
  {
    id: "2:65773-1",
    ...I235_40,
    workers: false,
    workerPresence: { definition: ["humans_in_right_of_way"] },
    lanes:
      "1/4 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 entrance-lane open, 6 shoulder open",
    effects: ["lane_restriction some_lanes_closed 1/4 closed", "speed_limit 88.514 km/h"],
    related: ["next-in-sequence 2:65773-2"],
  },
  {
    id: "2:65773-2",
    ...I235_40,
    ...CHECKED_IN_40,
    lanes:
      "1/4 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 exit-lane open, 6 shoulder open",
    effects: ["lane_restriction some_lanes_closed 1/4 closed", "speed_limit 88.514 km/h"],
    related: ["first-in-sequence 2:65773-1", "next-in-sequence 2:65773-3"],
  },
  {
    id: "2:65773-3",
    ...I235_40,
    ...CHECKED_IN_40,
    lanes:
      "1/3 closed: 1 shoulder closed, 2 general closed, 3 general open, 4 general open, 5 shoulder open",
    effects: ["lane_restriction some_lanes_closed 1/3 closed", "speed_limit 88.514 km/h"],
    related: ["first-in-sequence 2:65773-1"],
  },
];

/**
 * 4.0's detour scenario links the work zone to its detour by `children` and
 * each detour to the work zone by `parents`, which 4.1 restates as
 * `related-detour` and `related-work-zone`. The last detour's parent is
 * `6780`, a typo for `67890` and no road event of the feed, so it names
 * only the first detour; the work zone's `children` still name it.
 */
function detour40(speed: number): Case {
  const detour = {
    type: "detour",
    valid: ["2010-01-01T01:03:01Z", "2010-06-30T01:00:00Z"] as [string, string],
    status: "active",
    certainty: "observed",
    effects: ["detour"],
  };
  return {
    events: [
      {
        id: "1:67890",
        type: "roadworks",
        nature: "roadworks.works.resurfacing",
        direction: "northbound",
        roads: ["I-35"],
        valid: ["2010-01-01T01:03:01Z", "2010-06-30T01:00:00Z"],
        status: "active",
        certainty: "observed",
        position: [true, false],
        workers: true,
        workerPresence: {
          method: "scheduled",
          definition: WORKERS_ON_SITE,
          confidence: "medium",
        },
        lanes: "1/2 closed: 1 shoulder open, 2 general open, 3 general closed, 4 shoulder closed",
        effects: [
          "lane_restriction some_lanes_closed 1/2 closed",
          `speed_limit ${speed} km/h`,
          "width lte 3.353 m physical_limit lane 2",
        ],
        related: [
          "related-detour 1:67890-detour1",
          "related-detour 1:67890-detour2",
          "related-detour 1:67890-detour3",
        ],
      },
      {
        id: "1:67890-detour1",
        ...detour,
        direction: "westbound",
        roads: ["F22"],
        related: ["next-in-sequence 1:67890-detour2", "related-work-zone 1:67890"],
      },
      {
        id: "1:67890-detour2",
        ...detour,
        direction: "northbound",
        roads: ["US 69"],
        related: [
          "first-in-sequence 1:67890-detour1",
          "next-in-sequence 1:67890-detour3",
          "related-work-zone 1:67890",
        ],
      },
      {
        id: "1:67890-detour3",
        ...detour,
        direction: "eastbound",
        roads: ["IA 210"],
        related: ["first-in-sequence 1:67890-detour1"],
      },
    ],
    groups: {
      "1:67890": ["1:67890", "1:67890-detour1", "1:67890-detour2", "1:67890-detour3"],
    },
  };
}

const BEAVER_40 = {
  type: "roadworks",
  nature: "roadworks.works",
  roads: ["Beaver Avenue"],
  valid: ["2010-01-01T01:03:01Z", "2010-01-01T17:00:00Z"] as [string, string],
  status: "active",
};

const V40: Record<string, Case> = {
  "bridge_height_restriction_linestring_example.geojson": {
    // RoadRestrictionFeed road events state no dates. 10.5 ft is 3.2004 m,
    // 11 ft 3.3528 m and 9 ft 2.7432 m.
    events: [
      {
        id: "1:Bridge1",
        type: "dimension_restriction",
        nature: "restriction.dimension.height",
        direction: "northbound",
        roads: ["HRP", "Hutchinson Parkway", "Hutchinson River Parkway"],
        valid: [null, null],
        status: "active",
        lanes: "0/3 closed: 1 general open, 2 general open, 3 general open",
        effects: [
          "lane_restriction all_lanes_open 0/3 closed",
          "height lte 3.2 m maximum_permitted",
          "height lte 3.2 m maximum_permitted lane 1",
          "height lte 3.353 m maximum_permitted lane 2",
          "height lte 3.2 m maximum_permitted lane 3",
        ],
      },
      {
        id: "1:Bridge2",
        type: "dimension_restriction",
        nature: "restriction.dimension.height",
        direction: "southbound",
        roads: ["HRP", "Hutchinson Parkway", "Hutchinson River Parkway"],
        valid: [null, null],
        status: "active",
        effects: ["height lte 2.743 m maximum_permitted"],
      },
      {
        id: "1:Bridge3",
        type: "dimension_restriction",
        nature: "restriction.dimension.height",
        direction: "southbound",
        roads: ["HRP", "Hutchinson Parkway", "Hutchinson River Parkway"],
        valid: [null, null],
        status: "active",
        effects: ["height lte 3.353 m maximum_permitted"],
      },
    ],
  },
  "local_access_only_bidirectional_linestring_example.geojson": {
    events: [
      {
        id: "1:WZ389-NB",
        ...BEAVER_40,
        direction: "northbound",
        certainty: "likely",
        position: [false, false],
        effects: ["lane_restriction all_lanes_open", "access local_access_only"],
      },
      {
        id: "1:WZ389-SB",
        ...BEAVER_40,
        direction: "southbound",
        certainty: "observed",
        position: [true, false],
        lanes: "0/2 closed: 1 center-left-turn-lane open, 2 general open, 3 bike-lane open",
        effects: [
          "lane_restriction all_lanes_open 0/2 closed",
          "access local_access_only",
          "access local_access_only lane 1",
          "access local_access_only lane 2",
          "access local_access_only lane 3",
        ],
      },
    ],
  },
  "scenario1_simple_linestring_example.geojson": { events: SCENARIO1_40 },
  "scenario1_simple_multipoint_example.geojson": { events: SCENARIO1_40 },
  "scenario2_laneshift_linestring_example.geojson": {
    events: [
      {
        id: "1:7733",
        type: "roadworks",
        nature: "roadworks.works.resurfacing",
        direction: "westbound",
        roads: ["I-80", "I-35"],
        valid: ["2010-01-01T05:57:36Z", "2010-01-05T23:00:00Z"],
        status: "active",
        certainty: "observed",
        position: [true, true],
        workers: true,
        workerPresence: { method: "wearables_present", definition: WORKERS_ON_SITE },
        lanes:
          "0/3 closed: 1 shoulder closed, 2 general shift_right, 3 general shift_right, 4 general shift_right, 5 shoulder closed",
        effects: [
          "lane_restriction all_lanes_open_shift_right 0/3 closed",
          "speed_limit 88.5 km/h",
        ],
      },
    ],
  },
  // The eastbound road event closes its first general lane while stating
  // `all-lanes-open` (4.2's example corrects the lanes); both are read as
  // the example gives them. Their `parents` name the project `121388`, no
  // road event of the feed.
  "scenario3_shoulder_bidirectional_linestring_example.geojson": {
    events: [
      {
        id: "1:121388-EB",
        ...IA210,
        nature: "roadworks.works.maintenance",
        direction: "eastbound",
        certainty: "likely",
        position: [false, false],
        lanes: "1/2 closed: 1 general closed, 2 general open, 3 shoulder closed",
        effects: ["lane_restriction all_lanes_open 1/2 closed"],
      },
      {
        id: "1:121388-WB",
        ...IA210,
        nature: "roadworks.works",
        direction: "westbound",
        certainty: "likely",
        position: [false, false],
        lanes: "1/2 closed: 1 general closed, 2 general open, 3 shoulder open",
        effects: [
          "lane_restriction all_lanes_open 1/2 closed",
          "access no_parking",
          "access no_parking lane 3",
        ],
      },
    ],
  },
  "scenario4_detour_linestring_example.geojson": detour40(88.5),
  // Tag v4.0's recurring scenario is the detour scenario with a 55 km/h limit.
  "scenario5_recurring_linestring_example.geojson": detour40(55),
};

/**
 * The 3.0 examples at tag v3.1, the line string and the multipoint one alike
 * but for one cross street's name. Both events are `completed`, so archived.
 * Neither states the unit of its `reduced_speed_limit` of 30, and the
 * catalogue states none for this source, so each is counted unread rather
 * than guessed. Their `parents` name projects, no road events of the feed.
 */
const V30: Case = (() => {
  const common = {
    type: "roadworks",
    status: "archived",
    certainty: "observed",
    position: [false, false] as [boolean, boolean],
  };
  return {
    events: [
      {
        id: "1:12345",
        ...common,
        nature: "roadworks.works.line_marking",
        direction: "northbound",
        roads: ["Main Street", "I-100"],
        valid: ["2010-01-01T01:01:01Z", "2010-01-02T01:01:01Z"],
        workers: false,
        lanes: "2/3 closed: 1 lane open, 2 lane closed, 3 lane closed",
        effects: [
          "lane_restriction some_lanes_closed 2/3 closed",
          "width lte 3.048 m physical_limit lane 1",
        ],
      },
      {
        id: "2:67890",
        ...common,
        nature: "roadworks.works.roadside_work",
        direction: "westbound",
        roads: ["Barrett Street", "I-200"],
        valid: ["2010-01-01T01:03:01Z", "2010-01-02T01:07:01Z"],
        workers: true,
        lanes: "0/2 closed: 1 lane open, 2 lane open",
        effects: ["lane_restriction all_lanes_open 0/2 closed", "access prohibited truck lane 1"],
      },
    ],
    skipped: { unknown_value: 2 },
  };
})();

const CASES: [string, Case][] = [
  ...Object.entries(V40).map(([f, c]) => [`4.0 ${f}`, c] as [string, Case]),
  ...Object.entries(V41).map(([f, c]) => [`4.1 ${f}`, c] as [string, Case]),
  ...Object.entries(V42).map(([f, c]) => [`4.2 ${f}`, c] as [string, Case]),
  ["3.0 linestring_example.geojson", V30],
  ["3.0 multipoint_example.geojson", V30],
];

describe("WZDx official example feeds, read as they state", () => {
  it("covers every pinned example", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect([...files.keys()].sort()).toEqual(CASES.map(([name]) => name).sort());
  });

  it.for(CASES)("%s", ([name, expected], { skip }) => {
    if (unavailable) skip(unavailable);
    const { events, groups, skipped } = read(name);
    expect(events).toEqual(expected.events);
    expect(groups).toEqual(expected.groups ?? {});
    expect(skipped).toEqual(expected.skipped ?? {});
  });
});
