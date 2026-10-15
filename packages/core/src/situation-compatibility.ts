/** Conservative equivalence of traffic meaning, independent of provider IDs.
 * This is a display-fold guard, not a cross-source identity resolver. */
type Rec = Record<string, unknown>;
const object = (value: unknown): Rec | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
const without = (value: Rec, keys: readonly string[]): Rec =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const roadRef = (value: string): string => value.replace(/\s+/g, "").toUpperCase();

/** Object insertion order is not meaning; array order stays significant unless
 * the model explicitly defines the collection as unordered below. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  const record = object(value);
  return record
    ? Object.fromEntries(
        Object.entries(record)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, ordered(v)]),
      )
    : value;
}
const keyOf = (value: unknown): string => JSON.stringify(ordered(value)) ?? "null";
const unordered = (values: unknown[]): unknown[] =>
  values
    .map((value) => ({ value, key: keyOf(value) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ value }) => value);

function knownValidity(value: unknown): boolean {
  const validity = object(value);
  return typeof validity?.["status"] === "string" && validity["status"] !== "unknown";
}

function knownDirection(value: unknown, location: Rec): boolean {
  if (value === undefined) return true; // Absent = no directional constraint.
  const direction = object(value);
  if (direction?.["value"] === "both") return true;
  if (direction?.["value"] !== "positive" && direction?.["value"] !== "negative") return false;
  // Equal positive/negative labels do not establish an equal reference axis.
  switch (direction["basis"]) {
    case "road_reference": {
      const refs = new Set(
        ((location["roads"] as Rec[] | undefined) ?? [])
          .map((r) => r["ref"])
          .filter((r): r is string => typeof r === "string" && r.trim() !== "")
          .map(roadRef),
      );
      const linear = object(location["linear"]);
      if (typeof linear?.["ref"] === "string") refs.add(roadRef(linear["ref"]));
      return refs.size === 1;
    }
    case "alert_c": {
      const ref = object(location["tmc"]);
      return (
        typeof ref?.["country"] === "string" &&
        Number.isSafeInteger(ref["table"]) &&
        typeof ref["version"] === "string" &&
        Number.isSafeInteger(ref["code"]) &&
        Number(ref["code"]) > 0
      );
    }
    case "openlr":
      return typeof location["openlr"] === "string" && location["openlr"].trim() !== "";
    default:
      return false;
  }
}

/** Root points may differ within the spatial gate. Lines/areas and explicit
 * effect geometries must agree exactly; equal centroids are not equal extents. */
function locationMeaning(location: Rec, nearbyPoint: boolean): Rec | undefined {
  const geometry = object(location["geometry"]);
  if (
    !geometry ||
    location["fuzziness"] !== "exact" ||
    !knownDirection(location["direction"], location)
  )
    return undefined;
  const roads = location["roads"] as Rec[] | undefined;
  return {
    ...location,
    ...(roads
      ? {
          roads: unordered(
            roads.map((road) => ({
              ...road,
              ...(typeof road["ref"] === "string" ? { ref: roadRef(road["ref"]) } : {}),
            })),
          ),
        }
      : {}),
    // Retain any altitude, which can distinguish an overpass from the road below.
    geometry:
      nearbyPoint && geometry["type"] === "Point"
        ? { ...geometry, coordinates: (geometry["coordinates"] as unknown[]).slice(2) }
        : geometry,
  };
}

function effectMeaning(effect: Rec, location: Rec, validity: unknown): Rec | undefined {
  if (
    effect["normalization"] !== "complete" ||
    effect["kind"] === "unsupported" ||
    !object(effect["applicability"]) ||
    object(effect["applicability"])?.["kind"] === "unknown" ||
    effect["compliance"] === "unknown" ||
    (effect["issues"] as unknown[] | undefined)?.length
  )
    return undefined;
  const own = object(effect["location"]);
  const effective = { ...location, ...own };
  const loc = locationMeaning(effective, own?.["geometry"] === undefined);
  const direction = effect["direction"] ?? effective["direction"];
  const time = effect["validity"] ?? validity;
  if (!loc || !knownDirection(direction, effective) || !knownValidity(time)) return undefined;
  return {
    ...without(effect, ["id", "sourceRecordRef", "source", "location", "direction", "validity"]),
    location: loc,
    direction,
    validity: time,
  };
}

function effectMeanings(value: unknown, location: Rec, validity: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const effects = value.map((effect) => {
    const record = object(effect);
    return record ? effectMeaning(record, location, validity) : undefined;
  });
  return effects.some((effect) => effect === undefined) ? undefined : unordered(effects);
}

/** Undefined means the evidence is insufficient to discard another report.
 * All other canonical semantic fields are retained, including future fields. */
export function situationCompatibilityKey(record: Rec): string | undefined {
  const location = object(record["location"]);
  const provenance = object(record["provenance"]);
  if (
    !location ||
    typeof provenance?.["sourceId"] !== "string" ||
    (provenance["mergedSources"] as unknown[] | undefined)?.length ||
    record["certainty"] === "unknown" ||
    !knownValidity(record["validity"])
  )
    return undefined;
  const loc = locationMeaning(location, true);
  const effects = effectMeanings(record["effects"], location, record["validity"]);
  if (!loc || !effects) return undefined;
  const details = object(record["details"]);
  let phases: unknown[] | undefined;
  let typedEffects = effects.length;
  if (details?.["phases"] !== undefined) {
    if (!Array.isArray(details["phases"])) return undefined;
    phases = [];
    for (const value of details["phases"]) {
      const phase = object(value);
      if (!phase || !knownValidity(phase["validity"])) return undefined;
      const members = effectMeanings(phase["effects"], location, phase["validity"]);
      if (!members) return undefined;
      typedEffects += members.length;
      phases.push({ ...without(phase, ["id", "name", "effects"]), effects: members });
    }
  }
  if (typedEffects === 0) return undefined;
  const freshness = object(record["freshness"]);
  return keyOf({
    ...without(record, [
      "id",
      "canonicalId",
      "contentHash",
      "revision",
      "recordedAt",
      "provenance",
      "headline",
      "description",
      "externalIds",
      "extras",
      "groupId",
      "freshness",
      "location",
      "effects",
      "details",
    ]),
    location: loc,
    effects,
    details: details
      ? { ...without(details, ["phases"]), ...(phases ? { phases: unordered(phases) } : {}) }
      : undefined,
    freshness: freshness ? without(freshness, ["fetchedAt", "sourceCheckedAt"]) : undefined,
  });
}
