import {
  type Effect,
  effectStateAt,
  effectValidity,
  isRestrictionEvidence,
  isVehicleSpecific,
  type SituationClass,
  situationEffects,
  type Validity,
} from "@openconditions/model";
import { DATEX2_RECORDS, datexDiscriminator } from "@openconditions/model-roads";
import { XMLBuilder } from "fast-xml-parser";
import type { FeedInfo } from "./types.js";

type Rec = Record<string, unknown>;
type Text = { lang: string; text: string }[];

/**
 * DATEX II v3 SituationPublication emitter over situations. Spec:
 * https://docs.datex2.eu/ (v3 modular schemas: messageContainer / situation /
 * common / locationReferencing). Hand-built with fast-xml-parser, mirroring
 * the reader in `@openconditions/roads`.
 *
 * One `situation` per situation: a record for its nature (`DATEX2_RECORDS`),
 * then one record per effect in force or scheduled that DATEX has a
 * management record for (closures, lane restrictions, contraflow, speed
 * limits, diversions). An effect whose record would repeat the nature record
 * is folded into it; a nature without a record of its own leads with its first
 * effect's. A record keeps the DATEX id it was read from (`sourceRecordRef`),
 * else `<situation id>#<effect id>`. Probability, severity, headline and delay
 * describe the whole situation and travel on its leading record.
 *
 * Honest labeling: a pragmatic SituationPublication-shaped export, NOT
 * SRTI-profile-conformant and NOT NAP-publication-ready — see
 * `docs/datex-conformance.md`. Every location is reduced to a representative
 * point; the publication creator carries one feed-level country.
 *
 * DATEX output cannot carry an effect's vehicle conditions faithfully, so a
 * situation with any vehicle-specific effect, or one that is restriction
 * evidence, is left out rather than exported with a changed meaning.
 */

const SEVERITY: Readonly<Record<string, string>> = {
  minor: "low",
  moderate: "medium",
  major: "high",
  critical: "highest",
};

const PROBABILITY: Readonly<Record<string, string>> = {
  observed: "certain",
  likely: "probable",
  possible: "riskOf",
  unlikely: "improbable",
};

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "carriagewayClosures",
};

/** The `Class:discriminator` code DATEX has for an effect, if any. */
function effectCode(effect: Effect): string | undefined {
  switch (effect.kind) {
    case "closure":
      return `RoadOrCarriagewayOrLaneManagement:${CLOSURE_BY_SCOPE[effect.scope] ?? "roadClosed"}`;
    case "lane_restriction":
      if (effect.vehicleImpact === "all_lanes_closed") {
        return "RoadOrCarriagewayOrLaneManagement:roadClosed";
      }
      return effect.vehicleImpact === "all_lanes_open"
        ? undefined
        : "RoadOrCarriagewayOrLaneManagement:laneClosures";
    case "contraflow":
      return "RoadOrCarriagewayOrLaneManagement:contraflow";
    case "speed_limit":
      return "SpeedManagement:speedRestrictionInOperation";
    case "detour":
      return "ReroutingManagement:followDiversionSigns";
    default:
      return undefined;
  }
}

/** What an effect adds to its record beyond the class: lanes, a speed, a queue. */
function effectFields(effect: Effect): Rec {
  switch (effect.kind) {
    case "lane_restriction": {
      const impact: Rec = {};
      if (effect.lanesClosed !== undefined)
        impact["sit:numberOfLanesRestricted"] = effect.lanesClosed;
      if (effect.lanesTotal !== undefined && effect.lanesClosed !== undefined) {
        impact["sit:numberOfOperationalLanes"] = effect.lanesTotal - effect.lanesClosed;
      }
      return Object.keys(impact).length > 0 ? { "sit:impact": impact } : {};
    }
    case "speed_limit":
      return { "sit:temporarySpeedLimit": effect.limit.value };
    default:
      return {};
  }
}

/** An effect DATEX cannot carry without widening or misstating it. */
const untellable = (effect: Effect) => isVehicleSpecific(effect) || isRestrictionEvidence(effect);

/** First coordinate of any geometry, as [lon, lat]. */
function representativePoint(geometry: unknown): [number, number] | null {
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (g?.type === "GeometryCollection") {
    for (const part of g.geometries ?? []) {
      const found = representativePoint(part);
      if (found) return found;
    }
    return null;
  }
  let c: unknown = g?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
    ? [c[0], c[1]]
    : null;
}

function buildLocation(location: Rec): Rec {
  const road = (location["roads"] as Rec[] | undefined)?.[0];
  const loc: Rec = { "@_xsi:type": "loc:PointLocation" };
  const name = (road?.["name"] as Text | undefined)?.[0]?.text;
  if (name) loc["loc:roadName"] = name;
  if (typeof road?.["ref"] === "string") loc["loc:roadNumber"] = road["ref"];
  const pt = representativePoint(location["geometry"]);
  if (pt) {
    loc["loc:pointByCoordinates"] = {
      "loc:pointCoordinates": { "loc:latitude": pt[1], "loc:longitude": pt[0] },
    };
  }
  return loc;
}

function buildValidity(validity: Validity): Rec {
  const out: Rec = {
    "com:validityStatus": validity.status === "suspended" ? "suspended" : "active",
  };
  const spec: Rec = {};
  if (validity.start) spec["com:overallStartTime"] = validity.start;
  if (validity.end) spec["com:overallEndTime"] = validity.end;
  if (Object.keys(spec).length > 0) out["com:validityTimeSpecification"] = spec;
  return out;
}

function comment(text: Text): Rec {
  return {
    "com:comment": {
      "com:values": {
        "com:value": text.map((t) => ({ "@_lang": t.lang, "#text": t.text })),
      },
    },
  };
}

/**
 * A record of `code` (`Class` or `Class:discriminator`) in schema order: the
 * header, `before` (probability and severity), validity, then `after` and
 * the discriminator.
 */
function record(
  code: string,
  id: string,
  version: string,
  time: string,
  validity: Validity,
  before: Rec,
  after: Rec,
): Rec {
  const [cls, value] = code.split(":") as [string, string | undefined];
  const discriminator = datexDiscriminator(cls);
  return {
    "@_xsi:type": `sit:${cls}`,
    "@_id": id,
    "@_version": version,
    "sit:situationRecordCreationTime": time,
    "sit:situationRecordVersionTime": time,
    ...before,
    "sit:validity": buildValidity(validity),
    ...after,
    ...(value && discriminator ? { [`sit:${discriminator}`]: value } : {}),
  };
}

/** The DATEX record a classification has of its own: subtype's, else type's. */
function natureRecordCode(c: SituationClass): string | undefined {
  const type = `${c.kind}.${c.type}`;
  const code = c.subtype ? DATEX2_RECORDS[`${type}.${c.subtype}`] : undefined;
  return (code ?? DATEX2_RECORDS[type]) || undefined;
}

/** The DATEX records of a situation at `at`; none when DATEX cannot tell it truthfully. */
export function datexRecordsOf(situation: Rec, at: Date): Rec[] {
  const effects = situationEffects(situation);
  if (effects.some(untellable)) return [];
  const id = situation["id"] as string;
  const version = String(situation["revision"] ?? 1);
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const time =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  const location = buildLocation(situation["location"] as Rec);

  // What the situation says as a whole travels on its leading record.
  const severity = SEVERITY[String((situation["severity"] as Rec | undefined)?.["label"])];
  const headline = situation["headline"] as Text | undefined;
  const whole: Rec = {
    "sit:probabilityOfOccurrence": PROBABILITY[String(situation["certainty"])] ?? "certain",
    ...(severity ? { "sit:severity": severity } : {}),
  };
  const delay = effects.find((e) => e.kind === "delay");
  const delays =
    delay?.kind === "delay" && delay.delay
      ? { "sit:delays": { "sit:delayTimeValue": delay.delay.value } }
      : {};
  const lead = (fields: Rec): Rec => {
    const impact = { ...(fields["sit:impact"] as Rec | undefined), ...delays };
    return {
      ...fields,
      ...(Object.keys(impact).length > 0 ? { "sit:impact": impact } : {}),
      ...(headline?.length ? { "sit:generalPublicComment": comment(headline) } : {}),
    };
  };

  const natureCode = natureRecordCode(situation as unknown as SituationClass);
  let natureFields: Rec | undefined = natureCode ? {} : undefined;
  const effectRecords: Rec[] = [];
  for (const effect of effects) {
    const { state } = effectStateAt(effect, validity, at);
    if (state === "ended" || state === "unknown") continue;
    const code = effectCode(effect);
    if (code === undefined) continue;
    const place = ownPlace(situation, effect);
    // An effect folds into the nature record only where it holds at the same place.
    if (code === natureCode && place === undefined) {
      natureFields = { ...natureFields, ...effectFields(effect) };
      continue;
    }
    const recordId = effect.sourceRecordRef ?? `${id}#${effect.id}`;
    const effectValid = effectValidity(effect, validity);
    const first = natureCode === undefined && effectRecords.length === 0;
    const fields = effectFields(effect);
    const r = first
      ? record(code, recordId, version, time, effectValid, whole, lead(fields))
      : record(code, recordId, version, time, effectValid, {}, fields);
    r["sit:locationReference"] = place === undefined ? location : buildLocation(place);
    effectRecords.push(r);
  }
  if (natureFields === undefined) return effectRecords;
  const nature = record(natureCode!, id, version, time, validity, whole, lead(natureFields));
  nature["sit:locationReference"] = location;
  return [nature, ...effectRecords];
}

/**
 * The place an effect holds at when it is not its situation's: its own
 * geometry with the situation's road references.
 */
function ownPlace(situation: Rec, effect: Effect): Rec | undefined {
  const own = effect.location as Rec | undefined;
  if (own?.["geometry"] == null) return undefined;
  return { ...(situation["location"] as Rec), ...own };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/**
 * Projects situations to a DATEX II v3 `SituationPublication`, evaluated at
 * `at`. `info.timestamp` sets `publicationTime`; `info.attribution` the
 * national identifier. `country` is the feed-level publication-creator
 * country code (ISO 3166-1 α-2).
 */
export function situationsToDatex(
  situations: readonly Rec[],
  at: Date = new Date(),
  info: FeedInfo = {},
  country = "other",
): string {
  const payload: Rec = {
    "@_xsi:type": "sit:SituationPublication",
    "@_lang": "en",
  };
  if (info.timestamp) payload["com:publicationTime"] = info.timestamp;
  payload["com:publicationCreator"] = {
    "com:country": country,
    "com:nationalIdentifier": info.attribution ?? "OpenConditions",
  };
  payload["sit:situation"] = situations.flatMap((situation) => {
    const records = datexRecordsOf(situation, at);
    if (records.length === 0) return [];
    return [
      {
        "@_id": situation["id"],
        "@_version": String(situation["revision"] ?? 1),
        "sit:headerInformation": {
          "com:confidentiality": "noRestriction",
          "com:informationStatus": "real",
        },
        "sit:situationRecord": records,
      },
    ];
  });
  const doc = {
    messageContainer: {
      "@_xmlns": "http://datex2.eu/schema/3/messageContainer",
      "@_xmlns:com": "http://datex2.eu/schema/3/common",
      "@_xmlns:loc": "http://datex2.eu/schema/3/locationReferencing",
      "@_xmlns:sit": "http://datex2.eu/schema/3/situation",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_modelBaseVersion": "3",
      payload,
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
