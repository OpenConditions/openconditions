import {
  type Effect,
  effectStateAt,
  effectValidity,
  type SituationClass,
  situationEffects,
  type Validity,
} from "@openconditions/model";
import {
  DATEX2_FAULTY_EQUIPMENT,
  DATEX2_RECORDS,
  datexDiscriminator,
} from "@openconditions/model-roads";
import { XMLBuilder } from "fast-xml-parser";
import { type ExportDiagnosticSink, ProjectionDiagnostics } from "./export-diagnostics.js";
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
 * else `<situation id>#<effect id>`. Every record states the situation's
 * probability; severity, headline and delay describe the whole situation and
 * travel on its leading record.
 *
 * The output validates against the base DATEX II v3.7 schemas inside an
 * Exchange 2020 `messageContainer`, but it is NOT SRTI-profile-conformant
 * and NOT NAP-publication-ready — see `docs/datex-conformance.md`. Every
 * location is reduced to a representative point; the publication creator
 * carries one feed-level country.
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

/** v3 dropped v2's `improbable`; it travels as an extended value. */
const PROBABILITY: Readonly<Record<string, string | Rec>> = {
  observed: "certain",
  likely: "probable",
  possible: "riskOf",
  unlikely: extended("improbable"),
};

const COMPLIANCE: Readonly<Record<string, string | Rec>> = {
  mandatory: "mandatory",
  advisory: "advisory",
  unknown: extended("unknown"),
};

/** Record classes deriving from `NetworkManagement`, which must state their compliance. */
const NETWORK_MANAGEMENT = new Set([
  "GeneralNetworkManagement",
  "ReroutingManagement",
  "RoadOrCarriagewayOrLaneManagement",
  "SpeedManagement",
  "WinterDrivingManagement",
]);

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "carriagewayClosures",
};

/** A DATEX enumeration value outside the schema's list. */
function extended(value: string): Rec {
  return { "@__extendedValue": value, "#text": "_extended" };
}

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

/** What an effect says about the record's impact: its lanes. */
function effectImpact(effect: Effect): Rec {
  if (effect.kind !== "lane_restriction") return {};
  const impact: Rec = {};
  if (effect.lanesClosed !== undefined) impact["sit:numberOfLanesRestricted"] = effect.lanesClosed;
  if (effect.lanesTotal !== undefined && effect.lanesClosed !== undefined) {
    impact["sit:numberOfOperationalLanes"] = effect.lanesTotal - effect.lanesClosed;
  }
  return impact;
}

/** What an effect adds after its record's discriminator: a speed. */
function effectDetail(effect: Effect): Rec {
  return effect.kind === "speed_limit" ? { "sit:temporarySpeedLimit": effect.limit.value } : {};
}

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

/** A road's name, plain in `roadInformation`, so only its first language. */
const roadName = (road: Rec) => (road["name"] as Text | undefined)?.[0];

function buildLocation(
  location: Rec,
  diagnostics: ProjectionDiagnostics,
  path: string,
  effect?: Effect,
  directionPath = path,
): Rec {
  const loc: Rec = { "@_xsi:type": "loc:PointLocation" };
  const roads = ((location["roads"] as Rec[] | undefined) ?? []).flatMap((road) => {
    const info: Rec = {};
    const name = roadName(road)?.text;
    if (name) info["loc:roadName"] = name;
    if (typeof road["ref"] === "string") info["loc:roadNumber"] = road["ref"];
    return Object.keys(info).length > 0 ? [info] : [];
  });
  if (roads.length > 0) {
    loc["loc:supplementaryPositionalDescription"] = { "loc:roadInformation": roads };
  }
  const pt = representativePoint(location["geometry"]);
  if (pt) {
    if ((location["geometry"] as Rec | undefined)?.["type"] !== "Point")
      diagnostics.emit(
        "geometry_to_point",
        "field",
        "reduced",
        `${path}/geometry`,
        "DATEX exports this geometry as its first representative coordinate only.",
        effect,
      );
    loc["loc:pointByCoordinates"] = {
      "loc:pointCoordinates": { "loc:latitude": pt[1], "loc:longitude": pt[0] },
    };
  }
  if (location["direction"] !== undefined)
    diagnostics.emit(
      "direction_not_exported",
      "field",
      "omitted",
      `${directionPath}/direction`,
      "This DATEX emitter does not export location direction.",
      effect,
    );
  return loc;
}

/**
 * DATEX requires a start; without a declared one, the record is valid from
 * `since`, its version time, the earliest moment it is known to hold.
 */
function buildValidity(validity: Validity, since: string): Rec {
  const spec: Rec = { "com:overallStartTime": validity.start ?? since };
  if (validity.end) spec["com:overallEndTime"] = validity.end;
  return {
    "com:validityStatus": validity.status === "suspended" ? "suspended" : "active",
    "com:validityTimeSpecification": spec,
  };
}

function comment(text: Text): Rec {
  return {
    "sit:comment": {
      "com:values": {
        "com:value": text.map((t) => ({ "@_lang": t.lang, "#text": t.text })),
      },
    },
  };
}

interface RecordHeader {
  id: string;
  version: string;
  time: string;
  probability: string | Rec;
}

interface RecordBody {
  validity: Validity;
  location: Rec;
  /** Severity and the headline: what only the leading record carries. */
  lead?: { severity?: string; headline?: Text };
  impact?: Rec;
  compliance?: string;
  detail?: Rec;
}

/**
 * A record of `code` (`Class` or `Class:discriminator`) in schema order: the
 * situation record's elements up to its location, then the class's own —
 * compliance for network management, the discriminator and `detail`.
 */
function record(code: string, header: RecordHeader, body: RecordBody): Rec {
  const [cls, value] = code.split(":") as [string, string | undefined];
  const discriminator = datexDiscriminator(cls);
  const { lead, impact } = body;
  return {
    "@_xsi:type": `sit:${cls}`,
    "@_id": header.id,
    "@_version": header.version,
    "sit:situationRecordCreationTime": header.time,
    "sit:situationRecordVersionTime": header.time,
    "sit:probabilityOfOccurrence": header.probability,
    ...(lead?.severity ? { "sit:severity": lead.severity } : {}),
    "sit:validity": buildValidity(body.validity, header.time),
    ...(impact && Object.keys(impact).length > 0 ? { "sit:impact": impact } : {}),
    ...(lead?.headline?.length ? { "sit:generalPublicComment": comment(lead.headline) } : {}),
    "sit:locationReference": body.location,
    ...(NETWORK_MANAGEMENT.has(cls)
      ? {
          "sit:complianceOption": COMPLIANCE[body.compliance ?? "unknown"] ?? COMPLIANCE["unknown"],
        }
      : {}),
    ...(value && discriminator ? { [`sit:${discriminator}`]: value } : {}),
    ...body.detail,
  };
}

/** The DATEX record a classification has of its own: subtype's, else type's. */
function natureRecordCode(c: SituationClass): string | undefined {
  const type = `${c.kind}.${c.type}`;
  const code = c.subtype ? DATEX2_RECORDS[`${type}.${c.subtype}`] : undefined;
  return (code ?? DATEX2_RECORDS[type]) || undefined;
}

/** What a nature record names beyond its discriminator: a fault's equipment. */
function natureDetail(c: SituationClass, code: string): Rec {
  if (!code.startsWith("EquipmentOrSystemFault")) return {};
  const equipment = DATEX2_FAULTY_EQUIPMENT[`${c.kind}.${c.type}.${c.subtype}`] ?? "other";
  return { "sit:faultyEquipmentOrSystemType": equipment };
}

/** The DATEX records of a situation at `at`; none when DATEX cannot tell it truthfully. */
export function datexRecordsOf(situation: Rec, at: Date, report?: ExportDiagnosticSink): Rec[] {
  const effects = situationEffects(situation);
  const diagnostics = new ProjectionDiagnostics(situation, report);
  if (diagnostics.blocked("datex")) return [];
  const id = situation["id"] as string;
  const version = String(situation["revision"] ?? 1);
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const time =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  let location: Rec | undefined;
  const rootLocation = () =>
    (location ??= buildLocation(situation["location"] as Rec, diagnostics, "/location"));
  const probability = PROBABILITY[String(situation["certainty"])] ?? "certain";

  // What the situation says as a whole travels on its leading record.
  const lead = {
    severity: SEVERITY[String((situation["severity"] as Rec | undefined)?.["label"])],
    headline: situation["headline"] as Text | undefined,
  };
  const delay = effects.find((e) => e.kind === "delay");
  const delays: Rec =
    delay?.kind === "delay" && delay.delay
      ? { "sit:delays": { "sit:delayTimeValue": delay.delay.value } }
      : {};

  const classification = situation as unknown as SituationClass;
  const natureCode = natureRecordCode(classification);
  const folded: Effect[] | undefined = natureCode ? [] : undefined;
  const effectRecords: Rec[] = [];
  for (const effect of effects) {
    // Delay duration is a leading-record supplement, selected above independently
    // of management-effect time filtering. Do not claim the whole delay vanished.
    if (effect.kind === "delay") continue;
    const { state } = effectStateAt(effect, validity, at);
    const path = diagnostics.effectPath(effect);
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        state === "unknown" ? `${path}/issues` : effect.validity ? `${path}/validity` : "/validity",
        `No management record is exported for this effect at the evaluation instant: ${state}.`,
        effect,
      );
      continue;
    }
    const code = effectCode(effect);
    if (code === undefined) {
      diagnostics.emit(
        "unsupported_effect",
        "effect",
        "omitted",
        `${path}/kind`,
        "This effect has no DATEX management record mapping in the current emitter.",
        effect,
      );
      continue;
    }
    if (effect.direction !== undefined)
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/direction`,
        "This DATEX emitter does not export effect direction.",
        effect,
      );
    const place = ownPlace(situation, effect);
    if (place === undefined && effect.location?.direction !== undefined)
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/location/direction`,
        "This DATEX emitter does not export effect location direction.",
        effect,
      );
    // An effect folds into the nature record only where it holds at the same place.
    if (code === natureCode && place === undefined) {
      folded?.push(effect);
      continue;
    }
    const first = natureCode === undefined && effectRecords.length === 0;
    effectRecords.push(
      record(
        code,
        { id: effect.sourceRecordRef ?? `${id}#${effect.id}`, version, time, probability },
        {
          validity: effectValidity(effect, validity),
          location:
            place === undefined
              ? rootLocation()
              : buildLocation(
                  place,
                  diagnostics,
                  `${path}/location`,
                  effect,
                  effect.location?.direction === undefined ? "/location" : `${path}/location`,
                ),
          ...(first ? { lead } : {}),
          impact: { ...effectImpact(effect), ...(first ? delays : {}) },
          compliance: effect.compliance,
          detail: effectDetail(effect),
        },
      ),
    );
  }
  if (natureCode === undefined || folded === undefined) {
    diagnostics.emit(
      "unsupported_nature",
      "field",
      "omitted",
      "/type",
      "This situation classification has no DATEX nature record mapping in the current emitter.",
    );
    return effectRecords;
  }
  const nature = record(
    natureCode,
    { id, version, time, probability },
    {
      validity,
      location: rootLocation(),
      lead,
      impact: Object.assign({}, ...folded.map(effectImpact), delays),
      compliance: folded[0]?.compliance,
      detail: Object.assign(natureDetail(classification, natureCode), ...folded.map(effectDetail)),
    },
  );
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

/**
 * The payload's `lang`, the default language of its text: the one language of
 * every headline and road name written, `mul` when they differ, `und` when
 * there is none. Each headline value still states its own.
 */
function publicationLang(situations: readonly Rec[]): string {
  const langs = new Set<string>();
  for (const situation of situations) {
    for (const t of (situation["headline"] as Text | undefined) ?? []) langs.add(t.lang);
    const places = [situation["location"], ...situationEffects(situation).map((e) => e.location)];
    for (const place of places as (Rec | undefined)[]) {
      for (const road of (place?.["roads"] as Rec[] | undefined) ?? []) {
        const name = roadName(road);
        if (name) langs.add(name.lang);
      }
    }
  }
  const [only, ...more] = langs;
  if (only === undefined) return "und";
  return more.length > 0 ? "mul" : only;
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/**
 * Projects situations to a DATEX II v3 `SituationPublication` in an Exchange
 * 2020 snapshot-pull `messageContainer`, evaluated at `at`. `info.timestamp`
 * sets the publication and message time (else `at`); `info.attribution` the
 * national identifier. `country` is the feed-level publication-creator
 * country code (ISO 3166-1 α-2); the default `zz` is the user-assigned code
 * for an aggregate that spans countries.
 */
export function situationsToDatex(
  situations: readonly Rec[],
  at: Date = new Date(),
  info: FeedInfo = {},
  country = "zz",
): string {
  const time = info.timestamp ?? at.toISOString();
  const creator = {
    "com:country": country,
    "com:nationalIdentifier": info.attribution ?? "OpenConditions",
  };
  const exported = situations.flatMap((situation) => {
    const records = datexRecordsOf(situation, at);
    return records.length > 0 ? [{ situation, records }] : [];
  });
  const payload: Rec = {
    "@_xsi:type": "sit:SituationPublication",
    "@_lang": publicationLang(exported.map((e) => e.situation)),
    "@_modelBaseVersion": "3",
    "com:publicationTime": time,
    "com:publicationCreator": creator,
  };
  payload["sit:situation"] = exported.map(({ situation, records }) => ({
    "@_id": situation["id"],
    "sit:headerInformation": {
      "com:confidentiality": "noRestriction",
      "com:informationStatus": "real",
    },
    "sit:situationRecord": records,
  }));
  const doc = {
    messageContainer: {
      "@_xmlns": "http://datex2.eu/schema/3/messageContainer",
      "@_xmlns:com": "http://datex2.eu/schema/3/common",
      "@_xmlns:ex": "http://datex2.eu/schema/3/exchangeInformation",
      "@_xmlns:loc": "http://datex2.eu/schema/3/locationReferencing",
      "@_xmlns:sit": "http://datex2.eu/schema/3/situation",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_modelBaseVersion": "3",
      payload,
      exchangeInformation: {
        "@_modelBaseVersion": "3",
        "ex:exchangeContext": {
          "ex:codedExchangeProtocol": "snapshotPull",
          "ex:exchangeSpecificationVersion": "2020.1",
          "ex:supplierOrCisRequester": { "ex:internationalIdentifier": creator },
        },
        "ex:dynamicInformation": {
          "ex:exchangeStatus": "online",
          "ex:messageGenerationTimestamp": time,
        },
      },
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
