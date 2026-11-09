import { createHash } from "node:crypto";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, lonLat, type SiteInput, siteDraft } from "../site.js";

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const validId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
// The API documents int32 counts. Subsets are not additional spaces.
function count(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2147483647)
    throw new Error("parkreg: invalid capacity");
  return v;
}
function date(v: unknown): number {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new Error("parkreg: invalid date");
  if (new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19))
    throw new Error("parkreg: invalid calendar date");
  return Date.parse(v);
}
function collection(payloads: FeedPayloads, role: string): Map<number, Record<string, unknown>> {
  const bodies = payloads[role];
  if (bodies?.length !== 1) throw new Error(`parkreg: missing or partitioned ${role} collection`);
  const rows: unknown = JSON.parse(bodies[0]!.toString("utf8"));
  if (!Array.isArray(rows)) throw new Error(`parkreg: invalid ${role} collection`);
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (!object(row) || !validId(row["id"]) || byId.has(row["id"]))
      throw new Error(`parkreg: invalid or duplicate ${role} id`);
    byId.set(row["id"], row);
  }
  return byId;
}

/** Receipt binding: requalify after any endpoint, authorization, pacing or retention change. */
export function parkregAcquisitionHash(feed: ParkingCatalogFeed): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoints: feed.endpoints,
        auth: feed.auth,
        requestLimits: feed.requestLimits,
        rawRetention: feed.rawRetention,
      }),
    )
    .digest("hex");
}

function nationalAcquisition(feed: ParkingCatalogFeed): boolean {
  const base =
    "https://parkreg-open.atlas.vegvesen.no/ws/no/vegvesen/veg/parkeringsomraade/parkeringsregisteret/v1/parkeringsomraade?datafelter=";
  if (
    Object.keys(feed.endpoints).sort().join(",") !== "inventory,main" ||
    feed.catalog ||
    feed.auth
  )
    return false;
  for (const [role, projection] of [
    ["main", "alle"],
    ["inventory", "kart"],
  ]) {
    const endpoint = feed.endpoints[role!];
    if (!endpoint || endpoint.url !== base + projection) return false;
    // Only timing/size limits may accompany the fixed ordinary GET collection.
    if (
      Object.keys(endpoint).some(
        (key) => !["url", "cadenceSec", "timeoutSec", "budget"].includes(key),
      )
    )
      return false;
  }
  return feed.parkreg?.acquisitionSha256 === parkregAcquisitionHash(feed);
}

/** Ordinary national collections only. Historical versions, contacts and assessment/media links are never projected. */
export function parseVegvesenParkreg(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  if (feed.parkreg?.qualified !== true)
    throw new Error("parkreg: national load has not been qualified");
  if (!nationalAcquisition(feed))
    throw new Error("parkreg: national acquisition requires qualification");
  const rows = collection(payloads, "main");
  const inventory = collection(payloads, "inventory");
  if (rows.size !== inventory.size || [...rows.keys()].some((id) => !inventory.has(id)))
    throw new Error("parkreg: full collection differs from national map inventory");
  const now = date(ctx.fetchedAt);
  const out = emptyParseOutput();
  for (const [id, row] of rows) {
    if (row["deaktivert"] !== null) {
      if (!object(row["deaktivert"])) throw new Error("parkreg: missing deactivation state");
      date(row["deaktivert"]["deaktivertTidspunkt"]);
      continue;
    }
    const v = row["aktivVersjon"];
    if (!object(v) || !validId(v["versjonsnummer"]))
      throw new Error("parkreg: missing active version");
    const start = date(v["aktiveringstidspunkt"]);
    const end = v["sluttidspunkt"] === null ? Infinity : date(v["sluttidspunkt"]);
    if (end < start) throw new Error("parkreg: invalid active interval");
    if (start > now || end <= now) continue;
    const point = lonLat(row["lengdegrad"], row["breddegrad"]);
    if (!point || (point[0] === 0 && point[1] === 0)) throw new Error("parkreg: invalid geometry");
    const paid = count(v["antallAvgiftsbelagtePlasser"]);
    const free = count(v["antallAvgiftsfriePlasser"]);
    const total = paid !== undefined && free !== undefined ? paid + free : undefined;
    const areas: AreaInput[] = [];
    for (const [field, userGroup] of [
      ["antallForflytningshemmede", "disabled"],
      ["antallLadeplasser", "ev_charging"],
    ] as const) {
      const capacity = count(v[field]);
      if (capacity !== undefined && total !== undefined && capacity > total)
        throw new Error("parkreg: subset exceeds total");
      if (capacity !== undefined && capacity > 0)
        areas.push({ vehicleType: "car", userGroup, capacity });
    }
    const kind = v["typeParkeringsomrade"];
    const ride = v["innfartsparkering"];
    if (!["LANGS_KJOREBANE", "AVGRENSET_OMRADE", "PARKERINGSHUS"].includes(String(kind)))
      throw new Error("parkreg: unspecified or unknown area type");
    if (!["JA", "NEI", "IKKE_VALGT"].includes(String(ride)))
      recordSkipped(feed.id, "unknown_value");
    const input: SiteInput = {
      stationId: String(id),
      point,
      lang: "nb",
      capacityTotal: total,
      areas,
      ...(text(v["navn"]) ? { name: text(v["navn"]) } : {}),
      ...(text(row["parkeringstilbyderNavn"])
        ? { operator: text(row["parkeringstilbyderNavn"]) }
        : {}),
      address: {
        street: text(v["adresse"]),
        postalCode: text(v["postnummer"]),
        city: text(v["poststed"]),
      },
      ...(kind === "LANGS_KJOREBANE" ? { type: "on_street" } : {}),
      ...(kind === "AVGRENSET_OMRADE" || kind === "PARKERINGSHUS" ? { type: "off_street" } : {}),
      ...(kind === "AVGRENSET_OMRADE" ? { layout: "surface" } : {}),
      ...(ride === "JA" ? { type: "park_and_ride", usage: ["park_and_ride"] } : {}),
    };
    const draft = siteDraft(feed, input, ctx.fetchedAt);
    const modified = v["sistEndret"];
    if (modified !== undefined && modified !== null) date(modified);
    draft["provenance"] = {
      ...(draft["provenance"] as Record<string, unknown>),
      recordVersion: String(v["versjonsnummer"]),
      ...(typeof modified === "string" ? { sourceUpdatedAt: modified } : {}),
    };
    out.features.push(draft);
  }
  out.featureSnapshotComplete = true;
  return out;
}
