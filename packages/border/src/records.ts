import type { CatalogFeed, RecordDraft } from "@openconditions/ingest-framework";
import { observationId, recordLocalId } from "@openconditions/model";
import type {
  BORDER_MODES,
  BORDER_PROGRAMS,
  BORDER_WAIT_STATUSES,
} from "@openconditions/model-border";
import type { BorderCrossing } from "./crossings.js";

/** What a border record takes from its feed: its identity, its format and its terms. */
export type BorderFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl"
>;

export type BorderMode = (typeof BORDER_MODES)[number];
export type BorderProgram = (typeof BORDER_PROGRAMS)[number];
export type BorderWaitStatus = (typeof BORDER_WAIT_STATUSES)[number];

/** One inspection queue of a crossing, as a `lane_group` component. */
export interface LaneGroupInput {
  key: string;
  mode: BorderMode;
  program?: BorderProgram;
  direction: { from: string; to: string };
  /** How many lanes the queue has in all, open or not. */
  lanesTotal?: number;
}

/** What a border format knows of one crossing, beside its place in the vendored table. */
export interface CrossingInput {
  /** The feature's local id. */
  localId: string;
  /** The agency's own key of the port (a CBP port number, a CBSA office name). */
  recordId: string;
  name: string;
  /** The inspecting country, whose port this is. */
  country: string;
  /** The port's ids, where the agency publishes one. */
  portIds?: readonly { scheme: string; id: string; authority?: string }[];
  /** Where the agency says the crossing is, in words. */
  areaDescription?: string;
  /** What the agency tells travellers about the port, in English. */
  description?: string;
  openingHours?: Record<string, unknown>;
  lanes: readonly LaneGroupInput[];
  modes: readonly BorderMode[];
}

/** A crossing draft: the feature the queue readings hang on. */
export type CrossingDraft = RecordDraft & {
  id: string;
  location: Record<string, unknown>;
  provenance: Record<string, unknown>;
  freshness: Record<string, unknown>;
  components?: readonly { key: string }[];
};

/** The structured `border_wait` value of one queue. */
export interface WaitValue {
  status: BorderWaitStatus;
  waitMinutes?: number;
  lanesOpen?: number;
}

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const en = (text: string) => [{ lang: "en", text }];

/**
 * A `border_crossing` feature placed at its crossing of the vendored table,
 * with one `lane_group` per queue the port reports. The crossing carries its
 * Wikidata item and, for CBP, the port number, so the two agencies' features
 * of one crossing share a place and an item.
 */
export function crossingDraft(
  feed: BorderFeed,
  crossing: BorderCrossing,
  input: CrossingInput,
  fetchedAt: string,
): CrossingDraft {
  const components = input.lanes.map((lane) => ({
    key: lane.key,
    kind: "lane_group",
    details: {
      kind: "lane_group",
      v: 1,
      mode: lane.mode,
      ...(lane.program === undefined ? {} : { program: lane.program }),
      direction: lane.direction,
      ...(lane.lanesTotal === undefined ? {} : { lanesTotal: lane.lanesTotal }),
    },
  }));
  const portIds = input.portIds ?? [];
  return {
    id: `oc:feature:${feed.id}:${recordLocalId(input.localId)}`,
    class: "feature",
    kind: "border_crossing",
    temporality: "static",
    lifecycle: "operational",
    location: {
      geometry: { type: "Point", coordinates: [crossing.lon, crossing.lat] },
      extent: "point",
      // Neither agency publishes a position: it is the crossing's Wikidata
      // coordinate from the vendored table, not the feed's.
      geometryOrigin: "derived",
      fuzziness: "exact",
      admin: { country: input.country },
      ...(input.areaDescription === undefined
        ? {}
        : { areaDescription: en(input.areaDescription) }),
    },
    provenance: {
      origin: "feed",
      sourceId: feed.id,
      sourceFormat: feed.format,
      accessMode: "bulk",
      recordId: input.recordId,
      attribution: {
        provider: feed.attribution,
        license: feed.license,
        ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
      },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt },
    name: en(input.name),
    ...(input.description === undefined ? {} : { description: en(input.description) }),
    externalIds: [
      ...portIds.map((id) => ({ ...id })),
      { scheme: "wikidata", id: crossing.wikidata },
    ],
    ...(input.openingHours === undefined ? {} : { openingHours: input.openingHours }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "border_crossing",
      v: 1,
      countries: [...crossing.countries],
      ports: [
        {
          country: input.country,
          name: en(input.name),
          ...(portIds.length === 0
            ? {}
            : { externalIds: portIds.map(({ scheme, id }) => ({ scheme, id })) }),
        },
      ],
      modes: [...input.modes],
    },
  };
}

/** A reading of the crossing, located and attributed as the crossing is. */
function readingDraft(
  crossing: CrossingDraft,
  property: string,
  result: RecordDraft,
  at: string,
  componentKey?: string,
): RecordDraft {
  if (componentKey !== undefined && !crossing.components?.some((c) => c.key === componentKey)) {
    throw new Error(`${crossing.id} has no queue ${componentKey}`);
  }
  const draft = {
    class: "observation",
    kind: "observation",
    property,
    temporality: "live",
    location: crossing.location,
    provenance: crossing.provenance,
    freshness: crossing.freshness,
    subject: {
      kind: "feature",
      featureId: crossing.id,
      ...(componentKey === undefined ? {} : { componentKey }),
    },
    result,
    phenomenonTime: { instant: at },
    aggregation: "instantaneous",
  };
  const namespace = crossing.provenance["sourceId"] as string;
  return { id: observationId(namespace, draft as never), ...draft };
}

/** A `border.wait` reading of one queue at `at`. */
export function waitDraft(
  crossing: CrossingDraft,
  componentKey: string,
  value: WaitValue,
  at: string,
): RecordDraft {
  return readingDraft(
    crossing,
    "border.wait",
    { type: "structured", schema: "border_wait", v: 1, value: { v: 1, ...value } },
    at,
    componentKey,
  );
}

/** A `facility.open_status` reading of the whole crossing at `at`. */
export function openStatusDraft(
  crossing: CrossingDraft,
  status: "open" | "closed" | "unknown",
  at: string,
): RecordDraft {
  return readingDraft(
    crossing,
    "facility.open_status",
    { type: "category", value: status, vocabulary: "facility_open_status" },
    at,
  );
}
