import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS, observationId } from "@openconditions/model";
import type { RoadFeed } from "./feed-schema.js";

const LANG = "en";

/** The one face every CARS sign has. */
const FACE = "0";

const COMPASS = new Set<string>(COMPASS_POINTS);

interface CarsSign {
  id?: string;
  name?: string;
  status?: string;
  agencyName?: string;
  lastUpdated?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    routeId?: string;
    locationDescription?: string;
    signFacingDirection?: string;
  };
  properties?: { signType?: string; maxLinesPerPage?: number; maxCharactersPerLine?: number };
  display?: { pages?: { lines?: unknown[] }[] };
}

/** CARS sign types → the model's sign type: a full-matrix sign writes text and graphics anywhere. */
const SIGN_TYPES: Readonly<Record<string, string>> = { VMS_FULL: "matrix" };

/** CARS sign states → the model's working status. */
const WORKING_STATUSES: Readonly<Record<string, string>> = {
  DISPLAYING_MESSAGE: "in_service",
  BLANK: "blank",
  ERROR_OR_FAILURE: "fault",
};

/** A sign id as a feature id takes it: every character outside `[A-Za-z0-9._:-]` becomes `_`. */
const signKey = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "_");

/** An instant in UTC at second precision, as the drafts carry it. */
const utcInstant = (ms: number): string =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

const positive = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;

function provenance(feed: RoadFeed, recordId: string): Record<string, unknown> {
  return {
    origin: "feed",
    sourceId: feed.id,
    sourceFormat: feed.format,
    accessMode: feed.accessMode ?? "bulk",
    recordId,
    attribution: {
      provider: feed.attribution,
      license: feed.license,
      ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
    },
    privacy: { class: "authoritative" },
  };
}

/** The pages a sign shows, each line one text; a blank line keeps no text. */
function pagesOf(sign: CarsSign) {
  return (sign.display?.pages ?? []).flatMap((page) => {
    const lines = (page.lines ?? []).flatMap((line) =>
      typeof line === "string" && line.trim() !== "" ? [[{ lang: LANG, text: line.trim() }]] : [],
    );
    return lines.length > 0 ? [lines] : [];
  });
}

/**
 * Castle Rock CARS sign lists (`signs.json`, as 511NY publishes its dynamic
 * message signs): each sign as a `vms` feature with its one face, and a
 * `vms.display` reading of what the face shows, as of the sign's last
 * update. A blank sign shows no message; a sign in error shows none the
 * publisher states. A sign without an id or a position is left out and
 * counted.
 */
export function parseCarsSigns(
  feed: RoadFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const fetched = Date.parse(ctx.fetchedAt);
  for (const body of payloads["main"] ?? []) {
    const doc: unknown = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(doc)) throw new Error("the sign list is not an array");
    for (const raw of doc as CarsSign[]) {
      const id = typeof raw?.id === "string" ? raw.id.trim() : "";
      const lon = raw?.location?.longitude;
      const lat = raw?.location?.latitude;
      if (
        id === "" ||
        typeof lon !== "number" ||
        typeof lat !== "number" ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90 ||
        (lon === 0 && lat === 0)
      ) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const featureId = `oc:feature:${feed.id}:${signKey(id)}`;
      const facing = raw.location?.signFacingDirection?.trim().toUpperCase();
      const direction =
        facing !== undefined && COMPASS.has(facing)
          ? { value: "unknown", basis: "compass", compass: facing }
          : undefined;
      const route = raw.location?.routeId?.trim();
      const location = {
        geometry: { type: "Point", coordinates: [lon, lat] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
        ...(route ? { roads: [{ name: [{ lang: "und", text: route }] }] } : {}),
        ...(direction === undefined ? {} : { direction }),
      };
      const name = raw.name?.trim();
      const where = raw.location?.locationDescription?.trim();
      const agency = raw.agencyName?.trim();
      const rows = positive(raw.properties?.maxLinesPerPage);
      const chars = positive(raw.properties?.maxCharactersPerLine);
      out.features.push({
        id: featureId,
        class: "feature",
        kind: "vms",
        type: SIGN_TYPES[raw.properties?.signType ?? ""] ?? "other",
        temporality: "static",
        lifecycle: "operational",
        location,
        provenance: provenance(feed, id),
        freshness: { fetchedAt: ctx.fetchedAt },
        externalIds: [{ scheme: "provider", id, authority: feed.id }],
        ...(name ? { name: [{ lang: LANG, text: name }] } : {}),
        ...(where ? { description: [{ lang: LANG, text: where }] } : {}),
        ...(agency ? { operator: { role: "operator", name: [{ lang: LANG, text: agency }] } } : {}),
        components: [
          {
            key: FACE,
            kind: "sign_face",
            details: {
              kind: "sign_face",
              v: 1,
              vmsIndex: 0,
              ...(direction === undefined ? {} : { direction }),
              ...(rows === undefined ? {} : { textRows: rows }),
              ...(chars === undefined ? {} : { charsPerRow: chars }),
            },
          },
        ],
        details: { kind: "vms", v: 1 },
      } satisfies RecordDraft);
      const workingStatus = WORKING_STATUSES[raw.status ?? ""] ?? "unknown";
      const pages = workingStatus === "in_service" ? pagesOf(raw) : [];
      const updated =
        typeof raw.lastUpdated === "number" && Number.isFinite(raw.lastUpdated)
          ? Math.min(raw.lastUpdated, fetched)
          : fetched;
      const draft = {
        class: "observation",
        kind: "observation",
        property: "vms.display",
        temporality: "live",
        location,
        provenance: provenance(feed, id),
        freshness: { fetchedAt: ctx.fetchedAt },
        subject: { kind: "feature", featureId, componentKey: FACE },
        result: {
          type: "structured",
          schema: "vms_display",
          v: 1,
          value: {
            v: 1,
            workingStatus,
            messages:
              pages.length === 0
                ? []
                : [{ index: 0, text: pages.map((lines, i) => ({ page: i + 1, lines })) }],
          },
        },
        phenomenonTime: { instant: utcInstant(updated) },
        aggregation: "instantaneous",
      };
      out.observations.push({ id: observationId(feed.id, draft as never), ...draft });
    }
  }
  return out;
}
