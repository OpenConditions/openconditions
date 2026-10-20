import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCovered,
  type CoverageSpec,
  type JsonValidator,
  jsonSchemaEnums,
  jsonSchemaValidator,
  pinnedOrUnavailable,
  type SchemaFile,
} from "@openconditions/conformance";
import {
  WZDX_EXAMPLES,
  WZDX_FEED_SCHEMA,
  WZDX_ROAD_RESTRICTION_FEED_SCHEMA,
  WZDX_V31,
  WZDX_V40,
  WZDX_V41,
  WZDX_V42,
} from "@openconditions/conformance/standards/wzdx";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { buildRegistry, kernelModule } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RoadEvent } from "../model.js";
import { type SituationDraft, situationDrafts } from "../situation/assemble.js";
import { parseWzdx } from "../wzdx.js";

const SRC = {
  id: "wzdx-conformance",
  attribution: "TestDOT",
  country: "US",
  license: "CC0-1.0",
} as const;
const registry = buildRegistry([kernelModule, roadsModule]);
const FIXTURES = join(import.meta.dirname, "fixtures/wzdx");

const VERSIONS = ["3.1", "4.0", "4.1", "4.2"] as const;
type Version = (typeof VERSIONS)[number];
const SETS = { "3.1": WZDX_V31, "4.0": WZDX_V40, "4.1": WZDX_V41, "4.2": WZDX_V42 } as const;

type Json = Record<string, unknown>;

let unavailable: string | undefined;
const schemas = {} as Record<Version, SchemaFile[]>;
const feedValidators = {} as Record<Version, JsonValidator>;
let restrictionFeedValidator: JsonValidator;
const examples = {} as Record<string, SchemaFile[]>;

function validatorOf(files: readonly SchemaFile[], root: string): JsonValidator {
  const parsed = files.map((f) => ({ name: f.fileName, json: JSON.parse(f.contents) as Json }));
  const schema = parsed.find((f) => f.name === root);
  if (!schema) throw new Error(`no schema ${root}`);
  return jsonSchemaValidator(schema.json, {
    refs: parsed.filter((f) => f !== schema).map((f) => f.json),
  });
}

beforeAll(async () => {
  for (const version of VERSIONS) {
    const pinned = await pinnedOrUnavailable(SETS[version]);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    schemas[version] = pinned.files;
    feedValidators[version] = validatorOf(pinned.files, WZDX_FEED_SCHEMA[version]!);
  }
  restrictionFeedValidator = validatorOf(schemas["4.0"], WZDX_ROAD_RESTRICTION_FEED_SCHEMA);
  for (const [version, set] of Object.entries(WZDX_EXAMPLES)) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    examples[version] = pinned.files;
  }
}, 120_000);

beforeEach(() => __resetSkips());

/** An error as `<path> <message>`, without Ajv's parameters. */
const brief = (error: string) => error.replace(/ \{.*\}$/, "");

const parse = (feed: unknown) => parseWzdx(feed as object, SRC);
const draftsOf = (events: readonly RoadEvent[]) => situationDrafts(events, { source: SRC });

describe("WZDx fixtures against the schema of the version they declare", () => {
  /**
   * Each captured fixture with the version whose schema it is held to. CWZ
   * 1.0, the standard WZDx became, publishes no open schema; its fixture is
   * held to WZDx 4.2, whose WorkZoneFeed shape it uses.
   */
  const FIXTURE_VERSIONS: Record<string, Version> = {
    "feed.json": "4.2",
    "modot-v41.json": "4.1",
    "quebec-v31.json": "3.1",
    "cwz-pbs.json": "4.2",
  };

  /** What each publisher does that its version's schema does not allow, and why. */
  const DEVIATIONS: Record<string, { errors: string[]; reason: string }> = {
    "quebec-v31.json": {
      errors: [
        "/road_event_feed_info/data_sources/0 must have required property 'data_source_id'",
        "/features/0/properties/lanes/1/type must be equal to one of the allowed values",
      ],
      reason:
        "Ville de Québec leaves the feed's data source without its required data_source_id " +
        "(each road event still names one), and types a lane `unknown`, which 3.1's LaneType " +
        "does not have.",
    },
    "cwz-pbs.json": {
      errors: [
        "/features/0/properties/lanes/0/type must be equal to one of the allowed values",
        "/features/0/properties/lanes/1/type must be equal to one of the allowed values",
        "/features/0/properties/core_details/event_type must be equal to constant",
        "/features/0/properties must match exactly one schema in oneOf",
      ],
      reason:
        "PurposeBuilt types its lanes `left-lane` and `right-lane`, WZDx 3.1 LaneType values " +
        "4.0 removed; the WorkZoneRoadEvent branch fails on them, so the oneOf matches neither " +
        "it nor the detour branch.",
    },
  };

  it("lists every fixture that declares a version", () => {
    const declared = ["feed.json", "modot-v41.json", "quebec-v31.json", "cwz-pbs.json"].map(
      (name) => {
        const feed = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Json;
        const info = (feed["feed_info"] ?? feed["road_event_feed_info"]) as Json;
        return [name, info["version"]];
      },
    );
    expect(Object.fromEntries(declared)).toEqual({
      "feed.json": "4.2",
      "modot-v41.json": "4.1",
      "quebec-v31.json": "3.1",
      "cwz-pbs.json": "1.0",
    });
  });

  it.for(Object.entries(FIXTURE_VERSIONS))(
    "%s is valid against WZDx %s, or deviates exactly as recorded",
    ([name, version], { skip }) => {
      if (unavailable) skip(unavailable);
      const feed = JSON.parse(readFileSync(join(FIXTURES, name!), "utf8"));
      expect(feedValidators[version!](feed).map(brief)).toEqual(DEVIATIONS[name!]?.errors ?? []);
    },
  );

  it("reads Québec's out-of-standard lane type as no type, and counts it", () => {
    const events = parse(readFileSync(join(FIXTURES, "quebec-v31.json"), "utf8"));
    const wz = events.find((e) => e.type === "roadworks")!;
    expect(wz.lanesAffected!.lanes).toEqual([
      { index: 1, status: "alternating", type: "lane" },
      { index: 2, status: "open" },
      { index: 3, status: "open", type: "sidewalk" },
    ]);
    expect(drainSkipped(SRC.id)).toEqual({ unknown_value: 1 });
  });

  it("reads the CWZ fixture's 3.1 lane types as the general lanes 3.1 defines them as", () => {
    const [ev] = parse(readFileSync(join(FIXTURES, "cwz-pbs.json"), "utf8"));
    expect(ev!.lanesAffected!.lanes).toEqual([
      { index: 1, status: "shift_left", type: "left-lane" },
      { index: 2, status: "shift_left", type: "right-lane" },
    ]);
    expect(drainSkipped(SRC.id)).toEqual({});
  });

  it.for(["feed.json", "modot-v41.json"])("%s parses with nothing skipped", (name) => {
    const events = parse(readFileSync(join(FIXTURES, name), "utf8"));
    expect(events.length).toBeGreaterThan(0);
    expect(drainSkipped(SRC.id)).toEqual({});
  });
});

describe("WZDx official example feeds", () => {
  const featuresOf = (file: SchemaFile) =>
    (JSON.parse(file.contents) as Json)["features"] as Json[];
  const sealed = (events: readonly RoadEvent[]) => {
    for (const draft of draftsOf(events)) {
      const checked = registry.validateDraft(draft);
      expect(checked.ok ? [] : checked.issues).toEqual([]);
    }
  };

  it.for(["4.0", "4.2"] as const)(
    "every %s example is valid, parses with nothing skipped and assembles valid situations",
    (version, { skip }) => {
      if (unavailable) skip(unavailable);
      expect(examples[version]!.length).toBeGreaterThan(0);
      for (const file of examples[version]!) {
        const validate = file.fileName.includes("/RoadRestrictionFeed/")
          ? restrictionFeedValidator
          : feedValidators[version];
        expect(validate(JSON.parse(file.contents)), file.fileName).toEqual([]);
        const events = parse(file.contents);
        expect(events, file.fileName).toHaveLength(featuresOf(file).length);
        expect(drainSkipped(SRC.id), file.fileName).toEqual({});
        sealed(events);
      }
    },
  );

  // Tag v4.1's WorkZoneFeed examples give is_start_position_verified and
  // is_end_position_verified as the strings "true"/"false"; upstream fixed
  // them after the release ("Fix Work Zone Feed example GeoJSON files (#344)").
  // The WorkZoneRoadEvent branch fails on them, so the oneOf fails as a whole.
  it("every 4.1 example deviates only by its string position-verification flags, and parses", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    expect(examples["4.1"]!.length).toBeGreaterThan(0);
    for (const file of examples["4.1"]!) {
      const errors = feedValidators["4.1"](JSON.parse(file.contents)).map(brief);
      const features = featuresOf(file);
      expect(errors.length, file.fileName).toBeGreaterThan(0);
      for (const error of errors) {
        expect(error, file.fileName).toMatch(
          /^\/features\/\d+\/properties(\/is_(start|end)_position_verified must be boolean|\/core_details\/event_type must be equal to constant| must match exactly one schema in oneOf)$/,
        );
      }
      const flags = features
        .map((f) => (f["properties"] as Json)["is_start_position_verified"])
        .filter((v) => v !== undefined);
      expect(
        flags.some((flag) => typeof flag === "string"),
        file.fileName,
      ).toBe(true);
      const events = parse(file.contents);
      expect(events, file.fileName).toHaveLength(features.length);
      expect(drainSkipped(SRC.id), file.fileName).toEqual({});
      sealed(events);
    }
  });

  it("skips the 3.0 examples at tag v3.1 whole, as a version it does not read", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(examples["3.0"]!.length).toBe(2);
    for (const file of examples["3.0"]!) {
      const feed = JSON.parse(file.contents) as Json;
      expect((feed["road_event_feed_info"] as Json)["version"]).toBe("3.0");
      expect(parse(file.contents)).toEqual([]);
      expect(drainSkipped(SRC.id)).toEqual({ unsupported_version: featuresOf(file).length });
    }
  });
});

const LINE = {
  type: "LineString",
  coordinates: [
    [-93.0, 41.0],
    [-93.01, 41.01],
  ],
};

interface Probe {
  /** Core details (3.1: road event properties). */
  core?: Json;
  props?: Json;
}

const CORE = { data_source_id: "ds", direction: "northbound", road_names: ["I-80"] };
const DATES = { start_date: "2026-01-01T00:00:00Z", end_date: "2026-12-31T00:00:00Z" };

/** An object without the keys a probe set to `undefined`, so a probe can leave out a default. */
const defined = (o: Json): Json =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The road event properties a version requires of an event type, before the
 * probe's own; a probe value of `undefined` leaves a default out.
 */
function eventProperties(version: Version, eventType: "work-zone" | "detour", probe: Probe): Json {
  const core = defined({ ...CORE, event_type: eventType, ...probe.core });
  if (version === "3.1") {
    return defined({
      ...core,
      ...DATES,
      beginning_accuracy: "estimated",
      ending_accuracy: "estimated",
      start_date_accuracy: "estimated",
      end_date_accuracy: "estimated",
      vehicle_impact: "unknown",
      ...probe.props,
    });
  }
  const dateAccuracy =
    version === "4.0"
      ? { start_date_accuracy: "estimated", end_date_accuracy: "estimated" }
      : { is_start_date_verified: false, is_end_date_verified: false };
  const workZone =
    eventType !== "work-zone"
      ? {}
      : {
          vehicle_impact: "unknown",
          location_method: "channel-device-method",
          ...(version === "4.0"
            ? { beginning_accuracy: "estimated", ending_accuracy: "estimated" }
            : { is_start_position_verified: false, is_end_position_verified: false }),
        };
  return defined({ core_details: core, ...DATES, ...dateAccuracy, ...workZone, ...probe.props });
}

/** A one-event feed of a version, in that version's shape and header. */
function feedOf(version: Version, eventType: "work-zone" | "detour", probe: Probe = {}): Json {
  const header = {
    update_date: "2026-01-01T00:00:00Z",
    publisher: "TestDOT",
    version,
    data_sources: [
      {
        data_source_id: "ds",
        organization_name: "TestDOT",
        ...(version === "3.1" ? { location_method: "channel-device-method" } : {}),
      },
    ],
  };
  const headerKey = version === "3.1" || version === "4.0" ? "road_event_feed_info" : "feed_info";
  return {
    [headerKey]: header,
    type: "FeatureCollection",
    features: [
      {
        id: "e1",
        type: "Feature",
        properties: eventProperties(version, eventType, probe),
        geometry: LINE,
      },
    ],
  };
}

/**
 * A one-event 4.0 RoadRestrictionFeed, the only shape a restriction road event
 * has a schema in; 4.1 and 4.2 still list the `restriction` EventType.
 */
function restrictionFeedOf(version: Version, restrictions: Json[]): Json {
  return {
    feed_info: {
      update_date: "2026-01-01T00:00:00Z",
      publisher: "TestDOT",
      version,
      data_sources: [{ data_source_id: "ds", organization_name: "TestDOT" }],
    },
    type: "FeatureCollection",
    features: [
      {
        id: "r1",
        type: "Feature",
        properties: { core_details: { ...CORE, event_type: "restriction" }, restrictions },
        geometry: LINE,
      },
    ],
  };
}

/**
 * Parses a probe feed after checking it is valid WZDx. The record is read
 * only when the parser skipped nothing of it, values included.
 */
function read(
  feed: Json,
  validate: JsonValidator,
): { event: RoadEvent; draft: SituationDraft } | undefined {
  expect(validate(feed)).toEqual([]);
  const events = parse(feed);
  const skipped = drainSkipped(SRC.id);
  if (events.length !== 1 || Object.keys(skipped).length > 0) return undefined;
  const [draft] = draftsOf(events);
  return draft ? { event: events[0]!, draft } : undefined;
}

const readWorkZone = (version: Version, probe: Probe) =>
  read(feedOf(version, "work-zone", probe), feedValidators[version]);

type Effect = Json & { kind: string };
const effectsOf = (draft: SituationDraft) => draft["effects"] as Effect[];
const codeOf = (draft: SituationDraft) =>
  [draft["kind"], draft["type"], draft["subtype"]].filter((p) => p !== undefined).join(".");

/** True when every expected key is present in the actual object with an equal value. */
const matches = (actual: unknown, expected: Json): boolean =>
  !!actual &&
  typeof actual === "object" &&
  Object.entries(expected).every(([key, value]) =>
    value !== null && typeof value === "object"
      ? matches((actual as Json)[key], value as Json)
      : (actual as Json)[key] === value,
  );

/** A predicate from what each value means in the model: a value with no meaning listed is not handled. */
const meaning =
  <T>(expected: Readonly<Record<string, T>>, holds: (value: string, meant: T) => boolean) =>
  (value: string) =>
    value in expected && holds(value, expected[value]!);

/** Of a reason list, the values a version enumerates. */
const of = (values: readonly string[], reasons: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(reasons).filter(([value]) => values.includes(value)));

type Coverage = (version: Version, values: readonly string[]) => Record<string, CoverageSpec>;

const KILOGRAMS_PER_POUND = 0.45359237;
const METRES_PER_FOOT = 0.3048;

/** A restriction's values, chosen so each converts: a dimension type gets a limit in its own units. */
const RESTRICTION_PROBES: Record<string, Json> = {
  "reduced-width": { value: 10, unit: "feet" },
  "reduced-height": { value: 14, unit: "feet" },
  "reduced-length": { value: 60, unit: "feet" },
  "reduced-weight": { value: 20000, unit: "pounds" },
  "axle-load-limit": { value: 9000, unit: "kilograms" },
  "gross-weight-limit": { value: 36000, unit: "kilograms" },
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The kernel effect each WZDx RestrictionType is, as the RestrictionType page defines it. */
const RESTRICTION_EFFECTS: Record<string, Json> = {
  "no-trucks": {
    kind: "access",
    mode: "prohibited",
    applicability: { kind: "classes", include: { 0: { class: "truck" } } },
  },
  "no-parking": { kind: "access", mode: "no_parking" },
  "hov-2": {
    kind: "access",
    mode: "prohibited",
    applicability: { kind: "all", except: { 0: { hovMin: 2 } } },
  },
  "hov-3": {
    kind: "access",
    mode: "prohibited",
    applicability: { kind: "all", except: { 0: { hovMin: 3 } } },
  },
  "towing-prohibited": { kind: "access", mode: "towing_prohibited" },
  "permitted-oversize-loads-prohibited": { kind: "access", mode: "oversize_prohibited" },
  "local-access-only": { kind: "access", mode: "local_access_only" },
  "no-passing": { kind: "access", mode: "no_overtaking" },
  "reduced-width": {
    kind: "dimension_limit",
    dimension: "width",
    value: { value: round(10 * METRES_PER_FOOT), unit: "m" },
  },
  "reduced-height": {
    kind: "dimension_limit",
    dimension: "height",
    value: { value: round(14 * METRES_PER_FOOT), unit: "m" },
  },
  "reduced-length": {
    kind: "dimension_limit",
    dimension: "length",
    value: { value: round(60 * METRES_PER_FOOT), unit: "m" },
  },
  "reduced-weight": {
    kind: "dimension_limit",
    dimension: "gross_weight",
    value: { value: round(20000 * KILOGRAMS_PER_POUND), unit: "kg" },
  },
  "axle-load-limit": {
    kind: "dimension_limit",
    dimension: "axle_load",
    value: { value: 9000, unit: "kg" },
  },
  "gross-weight-limit": {
    kind: "dimension_limit",
    dimension: "gross_weight",
    value: { value: 36000, unit: "kg" },
  },
};

const NO_KERNEL_RULE = {
  "travel-peak-hours-only":
    "WZDx defines it only as 'travel restricted to travel peak hours only' and gives no " +
    "peak hours, so there is no window to bound an access rule by; it is carried as an " +
    "`unsupported` effect",
};

/** The restriction effect of a work zone carrying the restriction. */
const restrictionEffect = (version: Version, type: string, meant: Json) => {
  const restriction = { type, ...(version === "3.1" ? {} : RESTRICTION_PROBES[type]) };
  const read_ = readWorkZone(version, {
    props: { restrictions: [version === "3.1" ? type : restriction] },
  });
  if (!read_) return false;
  const effects = effectsOf(read_.draft).filter((e) => e.kind !== "lane_restriction");
  return effects.length === 1 && matches(effects[0], meant);
};

/** A lane restriction in a version's shape: 3.1's `LaneRestriction`, 4.x's `Restriction`. */
const laneRestriction = (version: Version, type: string, limit: Json = {}) =>
  version === "3.1"
    ? {
        restriction_type: type,
        ...(limit["value"] !== undefined
          ? { restriction_value: limit["value"], restriction_units: limit["unit"] }
          : {}),
      }
    : { type, ...limit };

/** The effects of a work zone whose first lane carries the restrictions, besides its lane_restriction. */
const laneRestrictionEffects = (version: Version, restrictions: Json[]) => {
  const read_ = readWorkZone(version, {
    props: {
      lanes: [
        { order: 1, status: "open", type: version === "3.1" ? "lane" : "general", restrictions },
        { order: 2, status: "open", type: version === "3.1" ? "lane" : "general" },
      ],
    },
  });
  return read_ && effectsOf(read_.draft).filter((e) => e.kind !== "lane_restriction");
};

/** The restriction effect of a work zone's first lane carrying the restriction, held to that lane. */
const laneRestrictionEffect = (version: Version, type: string, meant: Json) => {
  const effects = laneRestrictionEffects(version, [
    laneRestriction(version, type, RESTRICTION_PROBES[type]),
  ]);
  return (
    effects?.length === 1 &&
    matches(effects[0], meant) &&
    JSON.stringify(effects[0]!["laneScope"]) === JSON.stringify([{ index: 1, type: "general" }])
  );
};

/** The roads classification of a restriction road event, as the RestrictionType page defines it. */
const RESTRICTION_NATURES: Record<string, string> = {
  "no-trucks": "restriction.access.truck_ban",
  "hov-3": "restriction.access.hov",
  "hov-2": "restriction.access.hov",
  "no-parking": "restriction.access.no_parking",
  "reduced-width": "restriction.dimension.width",
  "reduced-height": "restriction.dimension.height",
  "reduced-length": "restriction.dimension.length",
  "reduced-weight": "restriction.dimension.weight",
  "axle-load-limit": "restriction.dimension.axle_load",
  "gross-weight-limit": "restriction.dimension.weight",
  "towing-prohibited": "restriction.access.towing_prohibited",
  "permitted-oversize-loads-prohibited": "restriction.access.oversize_prohibited",
  "local-access-only": "restriction.access.local_access_only",
  "no-passing": "restriction.access.no_overtaking",
};

/** The kernel lane type (and, for 3.1 types that carried one, the lane status) of each LaneType. */
const LANE_TYPES: Record<string, { type: string; status?: string }> = {
  general: { type: "general" },
  "exit-lane": { type: "exit" },
  "exit-ramp": { type: "ramp" },
  "entrance-lane": { type: "entrance" },
  "entrance-ramp": { type: "ramp" },
  sidewalk: { type: "sidewalk" },
  "bike-lane": { type: "bicycle" },
  shoulder: { type: "shoulder" },
  parking: { type: "parking" },
  median: { type: "median" },
  "two-way-center-turn-lane": { type: "center_turn" },
  "center-left-turn-lane": { type: "center_turn" },
  lane: { type: "general" },
  "left-lane": { type: "general" },
  "right-lane": { type: "general" },
  "middle-lane": { type: "general" },
  "center-lane": { type: "general" },
  "right-turning-lane": { type: "turn" },
  "left-turning-lane": { type: "turn" },
  "hov-lane": { type: "hov" },
  "right-shoulder": { type: "shoulder" },
  "left-shoulder": { type: "shoulder" },
  "right-exit-lane": { type: "exit" },
  "left-exit-lane": { type: "exit" },
  "right-second-exit-ramp": { type: "exit" },
  "left-second-exit-ramp": { type: "exit" },
  "right-exit-ramp": { type: "ramp" },
  "left-exit-ramp": { type: "ramp" },
  "right-entrance-lane": { type: "entrance" },
  "left-entrance-lane": { type: "entrance" },
  "right-second-entrance-ramp": { type: "entrance" },
  "left-second-entrance-ramp": { type: "entrance" },
  "right-entrance-ramp": { type: "ramp" },
  "left-entrance-ramp": { type: "ramp" },
  "right-merging-lane": { type: "general", status: "merge_left" },
  "left-merging-lane": { type: "general", status: "merge_right" },
  "alternating-flow-lane": { type: "general", status: "alternating" },
  "reversible-lane": { type: "general", status: "alternating" },
};

/** The kernel lane status of each LaneStatus. */
const LANE_STATUSES: Record<string, string> = {
  open: "open",
  closed: "closed",
  "shift-left": "shift_left",
  "shift-right": "shift_right",
  "merge-left": "merge_left",
  "merge-right": "merge_right",
  "alternating-flow": "alternating",
  "alternating-one-way": "alternating",
};

const laneOf = (version: Version, lane: Json) => {
  const read_ = readWorkZone(version, {
    props: {
      lanes: [{ order: 1, status: "open", type: version === "3.1" ? "lane" : "general", ...lane }],
    },
  });
  const effect = read_ && effectsOf(read_.draft).find((e) => e.kind === "lane_restriction");
  return (effect?.["lanes"] as Json[] | undefined)?.[0];
};

/**
 * Whether a work zone naming a detour of the feed as its `related-detour`
 * gets that detour as its own detour effect, the detour folded into it.
 */
function namesItsDetour(version: Version): boolean {
  const DETOUR_LINE = {
    type: "LineString",
    coordinates: [
      [-93.0, 41.0],
      [-93.02, 41.0],
    ],
  };
  const feed = feedOf(version, "work-zone", {
    core: { related_road_events: [{ type: "related-detour", id: "d1" }] },
  });
  (feed["features"] as Json[]).push({
    id: "d1",
    type: "Feature",
    properties: eventProperties(version, "detour", {}),
    geometry: DETOUR_LINE,
  });
  expect(feedValidators[version](feed)).toEqual([]);
  const events = parse(feed);
  if (Object.keys(drainSkipped(SRC.id)).length > 0) return false;
  const drafts = draftsOf(events);
  return (
    drafts.length === 1 &&
    effectsOf(drafts[0]!).some((e) => e.kind === "detour" && matches(e, { geometry: DETOUR_LINE }))
  );
}

/** Each enumeration the WZDx schemas define, by the name its definition has. */
const COVERAGE: Record<string, Coverage> = {
  EventType: (version) => ({
    "": {
      handled: meaning(
        {
          "work-zone": (r: ReturnType<typeof read>) =>
            r?.event.type === "roadworks" && codeOf(r.draft) === "roadworks.works",
          detour: (r: ReturnType<typeof read>) =>
            r?.event.type === "detour" &&
            effectsOf(r.draft).some((e) => e.kind === "detour" && matches(e, { geometry: LINE })),
          restriction: (r: ReturnType<typeof read>) =>
            r?.draft["kind"] === "restriction" &&
            effectsOf(r.draft).some((e) => e.kind === "access"),
        },
        (value, holds) =>
          holds(
            value === "restriction"
              ? read(restrictionFeedOf(version, [{ type: "no-parking" }]), restrictionFeedValidator)
              : read(feedOf(version, value as "work-zone" | "detour"), feedValidators[version]),
          ),
      ),
    },
  }),

  Direction: (_version) => ({
    "": {
      handled: meaning(
        {
          northbound: { value: "unknown", basis: "compass", compass: "N" },
          eastbound: { value: "unknown", basis: "compass", compass: "E" },
          southbound: { value: "unknown", basis: "compass", compass: "S" },
          westbound: { value: "unknown", basis: "compass", compass: "W" },
          // The loop is named, not applied: it has no axis a consumer could
          // put on one carriageway without knowing the ring.
          "inner-loop": { value: "unknown", basis: "text", loop: "inner" },
          "outer-loop": { value: "unknown", basis: "text", loop: "outer" },
          unknown: { value: "unknown" },
          // No signed direction: the geometry's order is the direction of travel.
          undefined: { value: "positive", basis: "geometry" },
        } as Record<string, Json>,
        (value, meant) => {
          const read_ = readWorkZone(_version, { core: { direction: value } });
          const direction = (read_?.draft["location"] as Json | undefined)?.["direction"] as
            | Json
            | undefined;
          return (
            matches(direction, meant) &&
            (meant["compass"] ?? null) === (direction?.["compass"] ?? null)
          );
        },
      ),
    },
  }),

  EventStatus: (version) => ({
    "": {
      handled: meaning(
        {
          planned: { status: "planned", temporality: "scheduled" },
          pending: { status: "planned", temporality: "scheduled" },
          active: { status: "active" },
          completed: { status: "ended" },
          cancelled: { status: "cancelled" },
        } as Record<string, Json>,
        (value, meant) => {
          const read_ = readWorkZone(version, { props: { event_status: value } });
          if (!read_) return false;
          const { temporality, ...validity } = meant;
          return (
            matches(read_.draft["validity"], validity) &&
            (temporality === undefined || read_.draft["temporality"] === temporality)
          );
        },
      ),
    },
  }),

  VehicleImpact: (version) => ({
    "": {
      handled: (value) => {
        const read_ = readWorkZone(version, { props: { vehicle_impact: value } });
        if (!read_) return false;
        const effects = effectsOf(read_.draft);
        return value === "all-lanes-closed"
          ? effects.some((e) => e.kind === "closure" && e["scope"] === "road")
          : effects.some(
              (e) =>
                e.kind === "lane_restriction" && e["vehicleImpact"] === value.replaceAll("-", "_"),
            );
      },
    },
  }),

  LaneStatus: (version) => ({
    "": {
      handled: meaning(
        LANE_STATUSES,
        (value, meant) => laneOf(version, { status: value })?.["status"] === meant,
      ),
    },
  }),

  LaneType: (version) => ({
    "": {
      handled: meaning(LANE_TYPES, (value, meant) =>
        matches(laneOf(version, { type: value }), meant),
      ),
    },
  }),

  WorkTypeName: (version) => ({
    "": {
      handled: meaning(
        {
          maintenance: "roadworks.works.maintenance",
          "minor-road-defect-repair": "roadworks.works.maintenance",
          "roadside-work": "roadworks.works.roadside_work",
          "overhead-work": "roadworks.works.overhead_work",
          "below-road-work": "roadworks.works.utility_work",
          "barrier-work": "roadworks.works.barrier_work",
          "surface-work": "roadworks.works.resurfacing",
          painting: "roadworks.works.line_marking",
          "roadway-relocation": "roadworks.works.construction",
          "roadway-creation": "roadworks.works.construction",
        },
        (value, meant) => {
          const read_ = readWorkZone(version, { props: { types_of_work: [{ type_name: value }] } });
          return read_ !== undefined && codeOf(read_.draft) === meant;
        },
      ),
    },
  }),

  RestrictionType: (version, values) => ({
    " (work zone restriction)": {
      handled: meaning(
        version === "3.1"
          ? Object.fromEntries(
              Object.entries(RESTRICTION_EFFECTS).filter(([, e]) => e["kind"] === "access"),
            )
          : RESTRICTION_EFFECTS,
        (value, meant) => restrictionEffect(version, value, meant),
      ),
      unsupported: of(values, {
        ...NO_KERNEL_RULE,
        ...(version === "3.1"
          ? Object.fromEntries(
              Object.keys(RESTRICTION_PROBES).map((type) => [
                type,
                "3.1 road restrictions are flags without a limit ('detailed restrictions are " +
                  "coded to specific lanes', read below), so there is no dimension to limit; " +
                  "the flag is carried as an `unsupported` effect",
              ]),
            )
          : {}),
      }),
    },
    " (lane restriction)": {
      handled: meaning(RESTRICTION_EFFECTS, (value, meant) =>
        laneRestrictionEffect(version, value, meant),
      ),
      unsupported: of(values, NO_KERNEL_RULE),
    },
    // Only 4.0 has a RestrictionRoadEvent schema to build one against.
    ...(version !== "4.0"
      ? {}
      : {
          " (restriction road event)": {
            handled: meaning(RESTRICTION_NATURES, (value, meant) => {
              const read_ = read(
                restrictionFeedOf(version, [{ type: value, ...RESTRICTION_PROBES[value] }]),
                restrictionFeedValidator,
              );
              return read_ !== undefined && codeOf(read_.draft) === meant;
            }),
            unsupported: of(values, {
              "travel-peak-hours-only":
                "the roads classification has no peak-hours-only nature; the event classifies " +
                "as a generic access restriction",
            }),
          },
        }),
  }),

  // WZDx is a US standard and calls all of feet, inches, pounds and tons
  // "Imperial system"; the US ton is the short ton of 2000 lb.
  UnitOfMeasurement: (version) => ({
    "": {
      handled: meaning(
        {
          feet: ["reduced-height", 14, round(14 * METRES_PER_FOOT)],
          inches: ["reduced-height", 168, round(168 * 0.0254)],
          centimeters: ["reduced-width", 300, 3],
          pounds: ["reduced-weight", 20000, round(20000 * KILOGRAMS_PER_POUND)],
          tons: ["gross-weight-limit", 10, round(10 * 2000 * KILOGRAMS_PER_POUND)],
          kilograms: ["reduced-weight", 9000, 9000],
        } as Record<string, [string, number, number]>,
        (unit, [type, value, canonical]) => {
          // 3.1 states a unit only on a lane restriction.
          const effects =
            version === "3.1"
              ? laneRestrictionEffects(version, [laneRestriction(version, type, { value, unit })])
              : (() => {
                  const read_ = readWorkZone(version, {
                    props: { restrictions: [{ type, value, unit }] },
                  });
                  return read_ && effectsOf(read_.draft);
                })();
          return (
            effects?.some(
              (e) => e.kind === "dimension_limit" && matches(e, { value: { value: canonical } }),
            ) ?? false
          );
        },
      ),
    },
  }),

  TimeVerification: (version) => ({
    "": {
      handled: meaning(
        { verified: ["observed", true], estimated: ["likely", false] } as Record<
          string,
          [string, boolean]
        >,
        (value, [certainty, verified]) => {
          const read_ = readWorkZone(version, {
            props: {
              start_date_accuracy: value,
              end_date_accuracy: value,
              is_start_date_verified: undefined,
              is_end_date_verified: undefined,
            },
          });
          return (
            read_?.draft["certainty"] === certainty &&
            matches(read_.draft["validity"], { startVerified: verified, endVerified: verified })
          );
        },
      ),
    },
  }),

  SpatialVerification: (version) => ({
    "": {
      handled: meaning({ verified: true, estimated: false }, (value, verified) => {
        const read_ = readWorkZone(version, {
          props: {
            beginning_accuracy: value,
            ending_accuracy: value,
            is_start_position_verified: undefined,
            is_end_position_verified: undefined,
          },
        });
        return matches(read_?.draft["details"], {
          startPositionVerified: verified,
          endPositionVerified: verified,
        });
      }),
    },
  }),

  LocationMethod: (version) => ({
    "": {
      handled: (value) => {
        // 3.1 states it per data source, 4.x per work zone.
        const feed = feedOf(
          version,
          "work-zone",
          version === "3.1" ? {} : { props: { location_method: value } },
        );
        if (version === "3.1") {
          const sources = (feed["road_event_feed_info"] as Json)["data_sources"] as Json[];
          sources[0]!["location_method"] = value;
        }
        const read_ = read(feed, feedValidators[version]);
        return matches(read_?.draft["details"], { locationMethod: value.replaceAll("-", "_") });
      },
    },
  }),

  WorkerPresenceMethod: (version) => ({
    "": {
      handled: (value) => {
        const read_ = readWorkZone(version, {
          props: { worker_presence: { are_workers_present: true, method: value } },
        });
        return matches(read_?.draft["details"], {
          workersPresent: true,
          workerPresenceMethod: value.replaceAll("-", "_"),
        });
      },
    },
  }),

  WorkerPresenceDefinition: (version) => ({
    "": {
      handled: meaning(
        {
          "workers-in-work-zone-working": "workers_working",
          "workers-in-work-zone-not-working": "workers_not_working",
          "mobile-equipment-in-work-zone-moving": "mobile_equipment_moving",
          "mobile-equipment-in-work-zone-not-working": "mobile_equipment_not_moving",
          "fixed-equipment-in-work-zone": "fixed_equipment",
          "humans-behind-barrier": "humans_behind_barrier",
          "humans-in-right-of-way": "humans_in_right_of_way",
        },
        (value, meant) => {
          const read_ = readWorkZone(version, {
            props: { worker_presence: { are_workers_present: true, definition: [value] } },
          });
          const details = read_?.draft["details"] as Json | undefined;
          return JSON.stringify(details?.["workerPresenceDefinition"]) === JSON.stringify([meant]);
        },
      ),
    },
  }),

  WorkerPresenceConfidence: (version) => ({
    "": {
      handled: (value) => {
        const read_ = readWorkZone(version, {
          props: { worker_presence: { are_workers_present: true, confidence: value } },
        });
        // It qualifies are_workers_present only, never the work zone's certainty.
        return (
          matches(read_?.draft["details"], { workerPresenceConfidence: value }) &&
          read_?.draft["certainty"] === readWorkZone(version, {})?.draft["certainty"]
        );
      },
    },
  }),

  WorkZoneType: (version) => ({
    "": {
      handled: meaning(
        { static: "static", moving: "moving", "planned-moving-area": "planned_moving_area" },
        (value, meant) => {
          const read_ = readWorkZone(version, { props: { work_zone_type: value } });
          return (read_?.draft["details"] as Json | undefined)?.["workZoneType"] === meant;
        },
      ),
    },
  }),

  RelatedRoadEventType: (version) => ({
    "": {
      handled: meaning(
        {
          "first-in-sequence": "group",
          "next-in-sequence": "group",
          "first-occurrence": "first_occurrence",
          "next-occurrence": "next_occurrence",
          "related-work-zone": "related_work_zone",
          "planned-moving-operation": "group",
          "active-moving-operation": "group",
          "related-detour": "detour",
        },
        (value, meant) => {
          if (meant === "detour") return namesItsDetour(version);
          const read_ = readWorkZone(version, {
            core: { related_road_events: [{ type: value, id: "other" }] },
          });
          const relations = (read_?.draft["relations"] ?? []) as Json[];
          return relations.length === 1 && relations[0]!["relation"] === meant;
        },
      ),
    },
  }),

  FeedLicense: (_version, values) => ({
    "": {
      handled: [],
      unsupported: Object.fromEntries(
        values.map((v) => [
          v,
          "a feed's licence is reviewed per source and taken from its source descriptor, not " +
            "from the feed",
        ]),
      ),
    },
  }),
};

/** Enumerations that fix the document's GeoJSON shape rather than say anything to map. */
const STRUCTURAL: Record<string, string> = {
  GeoJsonType:
    "`FeatureCollection` and `Feature` are the GeoJSON object types; the parser reads " +
    "`features[]` and each feature's geometry and properties",
};

/** The names 3.1 gave the enumerations 4.0 renamed. */
const RENAMED: Record<string, string> = {
  RoadRestriction: "RestrictionType",
  LaneRestrictionUnit: "UnitOfMeasurement",
};

/** Which enumeration a schema pointer holds; a pointer not listed here fails the coverage check. */
function enumerationOf(file: string, pointer: string): string {
  const definition = /^#\/definitions\/([^/]+)$/.exec(pointer)?.[1];
  if (definition) return RENAMED[definition] ?? definition;
  if (file === "Direction.json" && pointer === "#") return "Direction";
  if (pointer.endsWith("/core_details/properties/event_type")) return "EventType";
  if (
    pointer === "#/properties/license" ||
    pointer.endsWith("/RoadEventFeedInfo/properties/license")
  )
    return "FeedLicense";
  if (
    pointer === "#/properties/type" ||
    pointer === "#/definitions/RoadEventFeature/properties/type"
  )
    return "GeoJsonType";
  return `${file}${pointer}`;
}

/** Every enumeration of a version's schemas, its values merged across the pointers holding it. */
function enumerations(version: Version): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const file of schemas[version]) {
    if (file.fileName.startsWith("geojson/")) continue;
    for (const [pointer, values] of jsonSchemaEnums(JSON.parse(file.contents))) {
      const name = enumerationOf(file.fileName, pointer);
      const merged = out.get(name) ?? new Set();
      for (const v of values) merged.add(v);
      out.set(name, merged);
    }
  }
  return new Map([...out].map(([name, values]) => [name, [...values]]));
}

describe("WZDx enumerations read through parseWzdx", () => {
  it.for(VERSIONS)(
    "%s: every enumeration the schemas define is covered here",
    (version, { skip }) => {
      if (unavailable) skip(unavailable);
      const names = [...enumerations(version).keys()];
      expect(names.filter((n) => !(n in COVERAGE) && !(n in STRUCTURAL))).toEqual([]);
    },
  );

  it.for(VERSIONS)(
    "%s: every value is read as the standard means it, or listed as unsupported",
    (version, { skip }) => {
      if (unavailable) skip(unavailable);
      for (const [name, values] of enumerations(version)) {
        if (name in STRUCTURAL) continue;
        for (const [label, spec] of Object.entries(COVERAGE[name]!(version, values))) {
          assertCovered(`WZDx ${version} ${name}${label}`, values, spec);
        }
      }
    },
  );
});

describe("parseWzdx — skipped records and unread values, by reason", () => {
  const feature = (properties: unknown, geometry: unknown = LINE, id = "f") => ({
    id,
    type: "Feature",
    properties,
    geometry,
  });
  const core = (extra: Json = {}) => ({
    core_details: { ...CORE, event_type: "work-zone", ...extra },
  });

  it("counts each dropped feature under its reason and keeps the rest", () => {
    const events = parse({
      type: "FeatureCollection",
      feed_info: { version: "4.2" },
      features: [
        feature(core(), LINE, "kept"),
        feature(core(), null, "no-geometry"),
        feature(core(), { coordinates: [] }, "geometry-without-type"),
        null,
        feature(undefined, LINE, "no-properties"),
        feature({ core_details: { ...CORE } }, LINE, "no-event-type"),
        feature(core({ event_type: "incident" }), LINE, "unknown-type"),
        feature(core({ event_type: "work-zone-device" }), LINE, "unknown-type-2"),
      ],
    });
    expect(events.map((e) => e.id)).toEqual([`${SRC.id}:ds:kept`]);
    expect(drainSkipped(SRC.id)).toEqual({
      no_geometry: 2,
      malformed: 3,
      unknown_type: 2,
    });
  });

  it("counts every feature of a feed in a version it does not read", () => {
    const features = [feature(core()), feature(core(), LINE, "g")];
    for (const header of [
      { road_event_feed_info: { version: "3.0" } },
      { road_event_feed_info: { version: "2.0" } },
      { road_event_feed_info: { version: "1.0" } },
      { feed_info: { version: "5.0" } },
    ]) {
      expect(parse({ type: "FeatureCollection", ...header, features })).toEqual([]);
      expect(drainSkipped(SRC.id)).toEqual({ unsupported_version: 2 });
    }
  });

  it("reads 3.1, every 4.x, CWZ 1.x and a feed that declares no version", () => {
    for (const header of [
      { road_event_feed_info: { version: "3.1" } },
      { road_event_feed_info: { version: "4.0" } },
      { feed_info: { version: "4.1" } },
      { feed_info: { version: "4.2" } },
      { feed_info: { version: "1.0" } },
      {},
    ]) {
      expect(
        parse({ type: "FeatureCollection", ...header, features: [feature(core())] }),
      ).toHaveLength(1);
      expect(drainSkipped(SRC.id)).toEqual({});
    }
  });

  it("publishes a record without each enumerated value outside the standard, counting each", () => {
    const [ev] = parse({
      type: "FeatureCollection",
      feed_info: { version: "4.2" },
      features: [
        feature({
          ...core({ related_road_events: [{ type: "sibling", id: "x" }] }),
          vehicle_impact: "partially-closed",
          event_status: "ongoing",
          work_zone_type: "area",
          start_date_accuracy: "guessed",
          beginning_accuracy: "surveyed",
          location_method: "gps-method",
          worker_presence: {
            are_workers_present: true,
            method: "radar",
            definition: ["workers-on-break", "humans-behind-barrier"],
            confidence: "certain",
          },
          types_of_work: [{ type_name: "digging" }],
          restrictions: [{ type: "no-bikes" }, { type: "reduced-width", value: 3, unit: "yards" }],
          lanes: [
            { order: 1, status: "reversed", type: "general" },
            { order: 2, status: "open", type: "hov" },
          ],
        }),
      ],
    });
    expect(ev).toBeDefined();
    expect(ev!.workZoneType).toBeUndefined();
    expect(ev!.status).toBe("active");
    expect(ev!.situation?.validityStatus).toBeUndefined();
    expect(ev!.confidence).toBeUndefined();
    expect(ev!.relatedEvents).toEqual([{ id: "ds:x" }]);
    expect(ev!.lanesAffected?.lanes).toEqual([{ index: 2, status: "open" }]);
    expect(ev!.locationMethod).toBeUndefined();
    expect(ev!.positionVerified).toBeUndefined();
    expect(ev!.workerPresence).toEqual({ definition: ["humans_behind_barrier"] });
    expect(drainSkipped(SRC.id)).toEqual({ unknown_value: 15 });
  });

  it("counts nothing for a record whose every value is in the standard", () => {
    parse(readFileSync(join(FIXTURES, "feed.json"), "utf8"));
    expect(drainSkipped(SRC.id)).toEqual({});
  });
});

describe("parseWzdx — values read as the standard defines them", () => {
  it("reads 4.2's planned-moving-area work zone type, not a bare `area`", () => {
    const read_ = (work_zone_type: string) =>
      parse({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: LINE,
            properties: { core_details: { ...CORE, event_type: "work-zone" }, work_zone_type },
          },
        ],
      })[0]!;
    expect(read_("planned-moving-area").workZoneType).toBe("area");
    expect(read_("area").workZoneType).toBeUndefined();
  });

  it("keeps a publisher's are_workers_present of false", () => {
    const [ev] = parse(
      feedOf("4.2", "work-zone", { props: { worker_presence: { are_workers_present: false } } }),
    );
    expect(ev!.workersPresent).toBe(false);
  });

  it("lifts 3.1's restriction flags, lane restrictions, workers_present and road_name", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const feed = feedOf("3.1", "work-zone", {
      core: { road_names: undefined, road_name: "Main St" },
      props: {
        workers_present: true,
        restrictions: ["no-trucks", "reduced-height"],
        lanes: [
          {
            order: 1,
            status: "open",
            type: "lane",
            restrictions: [
              {
                restriction_type: "reduced-width",
                restriction_value: 10,
                restriction_units: "feet",
              },
            ],
          },
        ],
      },
    });
    expect(feedValidators["3.1"](JSON.parse(JSON.stringify(feed)))).toEqual([]);
    const [ev] = parse(feed);
    expect(ev!.roads.map((r) => r.name)).toEqual(["Main St"]);
    expect(ev!.workersPresent).toBe(true);
    expect(ev!.restrictions).toEqual([{ type: "no-trucks" }, { type: "reduced-height" }]);
    expect(ev!.lanesAffected!.lanes).toEqual([
      {
        index: 1,
        status: "open",
        type: "lane",
        restrictions: [{ type: "reduced-width", value: 10, unit: "feet" }],
      },
    ]);
    expect(drainSkipped(SRC.id)).toEqual({});
  });

  it("holds a lane's restriction to that lane, beside the road's own", () => {
    const read_ = readWorkZone("4.2", {
      props: {
        restrictions: [{ type: "no-trucks" }],
        lanes: [
          { order: 1, status: "open", type: "general" },
          {
            order: 2,
            status: "open",
            type: "general",
            restrictions: [{ type: "reduced-height", value: 13, unit: "feet" }, { type: "hov-2" }],
          },
          { order: 3, status: "open", type: "shoulder", restrictions: [{ type: "no-parking" }] },
        ],
      },
    });
    const effects = effectsOf(read_!.draft).filter((e) => e.kind !== "lane_restriction");
    expect(effects.map((e) => [e.kind, e["laneScope"]])).toEqual([
      ["access", undefined],
      ["dimension_limit", [{ index: 2, type: "general" }]],
      ["access", [{ index: 2, type: "general" }]],
      ["access", [{ index: 3, type: "shoulder" }]],
    ]);
    expect(effects[1]).toMatchObject({
      dimension: "height",
      value: { value: round(13 * METRES_PER_FOOT), unit: "m" },
      source: { path: "lanesAffected.lanes[1].restrictions[0]" },
    });
  });

  it("reads a work zone's worker presence, types of work and position and date verification", () => {
    const read_ = readWorkZone("4.2", {
      props: {
        is_start_date_verified: true,
        is_end_date_verified: false,
        is_start_position_verified: true,
        is_end_position_verified: false,
        location_method: "sign-method",
        types_of_work: [
          { type_name: "surface-work", is_architectural_change: false },
          { type_name: "roadway-relocation", is_architectural_change: true },
        ],
        worker_presence: {
          are_workers_present: true,
          method: "check-in-app",
          definition: ["workers-in-work-zone-working", "humans-behind-barrier"],
          worker_presence_last_confirmed_date: "2026-01-01T07:30:00Z",
          confidence: "high",
        },
      },
    })!;
    expect(read_.draft["details"]).toEqual({
      kind: "roadworks",
      v: 1,
      workersPresent: true,
      workerPresenceConfidence: "high",
      workerPresenceMethod: "check_in_app",
      workerPresenceDefinition: ["workers_working", "humans_behind_barrier"],
      workerPresenceConfirmedAt: "2026-01-01T07:30:00.000Z",
      typesOfWork: [
        { name: "surface_work", architecturalChange: false },
        { name: "roadway_relocation", architecturalChange: true },
      ],
      locationMethod: "sign_method",
      startPositionVerified: true,
      endPositionVerified: false,
    });
    expect(read_.draft["validity"]).toMatchObject({ startVerified: true, endVerified: false });
    expect(registry.validateDraft(read_.draft)).toMatchObject({ ok: true });
  });

  it("reads 3.1's sequence relationship as the related road events 4.1 replaced it with", () => {
    const [ev] = parse(
      feedOf("3.1", "work-zone", {
        props: { relationship: { first: ["e0"], next: ["e2"], parents: ["project-7"] } },
      }),
    );
    expect(ev!.relatedEvents).toEqual([
      { id: "ds:e0", type: "first-in-sequence" },
      { id: "ds:e2", type: "next-in-sequence" },
    ]);
    expect(drainSkipped(SRC.id)).toEqual({});
  });

  it("counts 3.1's total_num_lanes as the road's lanes where none is listed", () => {
    const [ev] = parse(feedOf("3.1", "work-zone", { props: { total_num_lanes: 3 } }));
    expect(ev!.lanesAffected).toEqual({ total: 3, vehicleImpact: "unknown" });
  });

  it("keeps the source's own properties as its raw record", () => {
    const feed = feedOf("3.1", "work-zone", { props: { restrictions: ["no-trucks"] } });
    const [ev] = parse(feed);
    expect(ev!.sourceRaw).toEqual(((feed["features"] as Json[])[0] as Json)["properties"]);
  });
});
