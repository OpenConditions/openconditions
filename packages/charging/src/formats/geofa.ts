import {
  digestPayload,
  emptyParseOutput,
  type FeedPayloads,
  geofaDigest,
  geofaFeatures,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  reprojectorFor,
} from "@openconditions/ingest-framework";
import { zonedWallClockToInstant } from "@openconditions/model";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { type EvseInput, evseKey, siteDraft } from "../site.js";
import { isRecord, placeAt, text } from "./raw.js";

const ALLOW = [
  "versions_id",
  "systid_fra",
  "systid_til",
  "oprettet",
  "effekt_type_kode",
  "antal_ladepunkter",
  "stiktype",
  "anvendelsesgrad_kwh",
  "driftstart_fra",
  "planstatus_kode",
  "gyldig_fra",
  "gyldig_til",
  ...Array.from({ length: 6 }, (_, i) => `internationalt_id${i || ""}`),
];

function day(value: unknown, next = false): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("GeoFA: invalid validity date");
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value)
    throw new Error("GeoFA: invalid validity day");
  if (next) d.setUTCDate(d.getUTCDate() + 1);
  const instant = zonedWallClockToInstant(
    "Europe/Copenhagen",
    `${d.toISOString().slice(0, 10)}T00:00:00`,
  );
  if (!instant) throw new Error("GeoFA: invalid Copenhagen boundary");
  return +instant;
}

/** GeoFA's administrative inventory, without live readings or linked content. */
/** Bind fixed request semantics; only bounded acquisition pagination may vary. */
function matchesCrsRequest(request: URL, base: URL, pageSize: number): boolean {
  if (
    request.origin !== base.origin ||
    request.pathname !== base.pathname ||
    request.username ||
    request.password ||
    request.hash
  )
    return false;
  const keys = new Set<string>();
  for (const [key, value] of request.searchParams) {
    const folded = key.toLowerCase();
    if (keys.has(folded)) return false;
    keys.add(folded);
    if (key === "count" || key === "startIndex") {
      if (!/^(0|[1-9]\d*)$/.test(value)) return false;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || (key === "count" ? n < 1 || n > pageSize : n > 49000))
        return false;
    } else if (!base.searchParams.has(key) || base.searchParams.get(key) !== value) return false;
  }
  for (const [key, value] of base.searchParams) {
    if (request.searchParams.get(key) !== value) return false;
  }
  return (
    base.searchParams.get("service") === "WFS" &&
    base.searchParams.get("version") === "2.0.0" &&
    base.searchParams.get("request") === "GetFeature" &&
    base.searchParams.get("outputFormat") === "application/json"
  );
}

export function parseGeofa(
  feed: ChargingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const seen = new Set<string>();
  const evseOwners = new Map<string, Set<string>>();
  const buffers = payloads["main"] ?? [];
  const features = geofaFeatures(buffers);
  const q = feed.endpoints?.["main"]?.geofa?.qualification;
  if (q && (q.count !== features.length || q.sha256 !== geofaDigest(features)))
    throw new Error("GeoFA: unqualified publication");
  const nonWithdrawing = feed.endpoints?.["main"]?.geofa?.nonWithdrawing === true;
  out.qualifiedFeatureSnapshot = q !== undefined && !nonWithdrawing;
  const documents = buffers.map((body) => JSON.parse(body.toString("utf8")));
  // GeoFA's requested EPSG:4326 GeoJSON is longitude/latitude (CRS84 axes).
  // Missing declarations need acquisition evidence bound to these exact bytes,
  // not an invented declaration or an assumption made by a direct parser caller.
  const systems = documents.map((doc, i) => {
    const crs = doc.crs?.properties?.name;
    if (crs === undefined) {
      const evidence = ctx.payloadEvidence?.["main"]?.[i];
      const configured = feed.endpoints?.["main"]?.url;
      if (!evidence || !configured) throw new Error("GeoFA: missing CRS request evidence");
      const request = new URL(evidence.url);
      const base = new URL(configured);
      const digest = digestPayload(evidence.url, buffers[i]!);
      if (
        !matchesCrsRequest(request, base, feed.endpoints?.["main"]?.geofa?.pageSize ?? 500) ||
        request.searchParams.get("srsName") !== "EPSG:4326" ||
        request.searchParams.get("typeNames") !== "fkg:fkg.t_5607_ladefacilitet" ||
        request.searchParams.get("sortBy") !== "objekt_id" ||
        digest.sha256 !== evidence.sha256 ||
        digest.bytes !== evidence.bytes
      )
        throw new Error("GeoFA: invalid CRS request evidence");
      return "geographic";
    }
    if (["EPSG:4326", "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC:1.3:CRS84"].includes(crs))
      return "geographic";
    if (["EPSG:25832", "urn:ogc:def:crs:EPSG::25832"].includes(crs)) return "EPSG:25832";
    throw new Error("GeoFA: unsupported CRS");
  });
  if (nonWithdrawing && new Set(systems).size > 1) throw new Error("GeoFA: mixed acquisition CRS");
  const versions = new Map<string, string[]>();
  const unique = new Map<string, Record<string, unknown>>();
  const identity = (id: string) => id.replaceAll("*", "").toUpperCase();
  const eligible = (p: Record<string, unknown>) =>
    ["off_kode", "statuskode", "ladefacilitet_type_kode", "tilgaengelighed_type_kode"].every(
      (k, i) => p[k] === [1, 3, 1, 1][i],
    );
  const idsFor = (p: Record<string, unknown>) =>
    Array.from({ length: 6 }, (_, i) => text(p[`internationalt_id${i || ""}`])).filter(
      (x): x is string => x !== undefined,
    );
  // Validate/coalesce all versions before making any ownership assertion. The digest
  // compares every projected field except the explicitly retained version evidence.
  for (const feature of features) {
    if (!isRecord(feature) || !isRecord(feature["properties"]))
      throw new Error("GeoFA: malformed feature");
    const p = feature["properties"];
    const id = text(p["objekt_id"]);
    if (!id) throw new Error("GeoFA: missing objekt_id");
    const prior = unique.get(id);
    if (prior) {
      if (!nonWithdrawing) throw new Error("GeoFA: duplicate objekt_id");
      const withoutVersion = (f: Record<string, unknown>) => ({
        ...f,
        properties: { ...(f["properties"] as Record<string, unknown>), versions_id: null },
      });
      if (geofaDigest([withoutVersion(prior)]) !== geofaDigest([withoutVersion(feature)]))
        throw new Error("GeoFA: conflicting facility versions");
      const v = text(p["versions_id"]);
      if (v) versions.get(id)!.push(v);
    } else {
      unique.set(id, feature);
      versions.set(id, text(p["versions_id"]) ? [String(p["versions_id"])] : []);
    }
  }
  for (const [id, feature] of unique) {
    const p = feature["properties"] as Record<string, unknown>;
    if (!eligible(p)) continue;
    const from = day(p["gyldig_fra"]);
    const until = day(p["gyldig_til"], true);
    if (from !== undefined && until !== undefined && from >= until)
      throw new Error("GeoFA: reversed validity");
    if (
      (from !== undefined && Date.parse(ctx.fetchedAt) < from) ||
      (until !== undefined && Date.parse(ctx.fetchedAt) >= until)
    )
      continue;
    for (const raw of idsFor(p)) {
      const key = identity(raw);
      const owners = evseOwners.get(key) ?? new Set<string>();
      owners.add(id);
      evseOwners.set(key, owners);
    }
  }
  for (const doc of documents) {
    const crs = doc.crs?.properties?.name;
    if (crs !== undefined && !/CRS84$|EPSG(?::|::)4326$|EPSG(?::|::)25832$/.test(crs))
      throw new Error("GeoFA: unsupported CRS");
    const project = reprojectorFor(crs);
    for (const feature of doc.features) {
      const p = feature["properties"];
      const id = text(p["objekt_id"])!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!eligible(p)) continue;
      const from = day(p["gyldig_fra"]);
      const until = day(p["gyldig_til"], true);
      if (from !== undefined && until !== undefined && from >= until)
        throw new Error("GeoFA: reversed validity");
      if (
        (from !== undefined && Date.parse(ctx.fetchedAt) < from) ||
        (until !== undefined && Date.parse(ctx.fetchedAt) >= until)
      )
        continue;
      const g = feature["geometry"];
      const coords =
        isRecord(g) &&
        g["type"] === "MultiPoint" &&
        Array.isArray(g["coordinates"]) &&
        g["coordinates"].length === 1
          ? g["coordinates"][0]
          : undefined;
      if (
        !Array.isArray(coords) ||
        coords.length !== 2 ||
        !coords.every((v) => typeof v === "number" && Number.isFinite(v))
      )
        throw new Error("GeoFA: expected one finite point");
      const xy = project ? project(coords as [number, number]) : (coords as [number, number]);
      const point = placeAt(xy[1], xy[0]);
      if (!point) throw new Error("GeoFA: unplaceable point");
      const ids = idsFor(p);
      const distinct = [...new Set(ids)].sort();
      const count = p["antal_ladepunkter"];
      const ambiguous = ids.some((raw) => (evseOwners.get(identity(raw))?.size ?? 0) > 1);
      if (ambiguous && !nonWithdrawing) throw new Error("GeoFA: conflicting EVSE identity");
      const resolved =
        typeof count === "number" &&
        Number.isInteger(count) &&
        count > 0 &&
        count === ids.length &&
        distinct.length === ids.length &&
        new Set(ids.map(identity)).size === ids.length &&
        !ambiguous;
      if (!resolved) recordSkipped(feed.id, "unknown_value");
      const lifecycle =
        p["planstatus_kode"] === 1
          ? "operational"
          : p["planstatus_kode"] === 2
            ? "planned"
            : "unknown";
      if (resolved && new Set(distinct.map(evseKey)).size !== distinct.length)
        throw new Error("GeoFA: conflicting EVSE component key");
      const evses: EvseInput[] = resolved
        ? distinct.map((id) => {
            // A facility-wide plug label cannot assign connectors among several EVSEs.
            const standard = /^type\s*2$/i.test(text(p["stiktype"]) ?? "")
              ? "IEC_62196_T2"
              : undefined;
            return {
              key: id,
              evseId: id,
              lifecycle,
              connectors: distinct.length === 1 && standard ? [{ id: "1", standard }] : [],
            };
          })
        : [];
      const draft = siteDraft(
        feed,
        {
          stationId: id,
          operator: text(p["operatoer_ladefacilitet"])
            ? { name: String(p["operatoer_ladefacilitet"]) }
            : undefined,
          owner: text(p["ejer_ladefacilitet"])
            ? { name: String(p["ejer_ladefacilitet"]) }
            : undefined,
          address: {
            street: text(p["vejnavn"]),
            houseNumber: text(p["husnr"]),
            postalCode: text(p["postnr"]),
            city: text(p["postnr_by"]),
          },
          point,
          lifecycle,
          audience: "public",
          evses,
        },
        ctx.fetchedAt,
      );
      if (nonWithdrawing) {
        const expiresAt = Math.min(Date.parse(ctx.fetchedAt) + 172800000, until ?? Infinity);
        draft["freshness"] = {
          fetchedAt: ctx.fetchedAt,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }
      const sourceVersions = [...new Set(versions.get(id))].sort();
      if (sourceVersions.length === 1)
        (draft["provenance"] as Record<string, unknown>)["recordVersion"] = sourceVersions[0];
      draft["extras"] = Object.fromEntries(
        ALLOW.filter(
          (k) =>
            p[k] !== undefined &&
            p[k] !== null &&
            (k !== "versions_id" || sourceVersions.length === 1),
        ).map((k) => [k, p[k]]),
      );
      if (sourceVersions.length > 1)
        (draft["extras"] as Record<string, unknown>)["geofaVersions"] = sourceVersions;
      out.features.push(draft);
    }
  }
  out.features.sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
  return out;
}
