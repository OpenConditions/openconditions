import type { FeedPayloads, ParseContext, ParseOutput } from "@openconditions/ingest-framework";
import { capReferences } from "@openconditions/model-hazards";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { accountSituations } from "../accounting.js";
import { currentMessages } from "../cap/messages.js";
import { capDrafts, capInstant } from "../cap/situations.js";
import type { CapAlert } from "../cap/types.js";
import { CAP_1_2_NAMESPACE, readCapXml } from "../cap/xml.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { isRecord } from "../records.js";

const DE = "urn:oasis:names:tc:emergency:EDXL:DE:1.0";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 3600_000;
const SENDER = "webmaster@rfs.nsw.gov.au";
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
});
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false });
type Node = Record<string, unknown>;
const REPEATED_CAP = new Set([
  "code",
  "info",
  "category",
  "responseType",
  "eventCode",
  "parameter",
  "resource",
  "area",
  "polygon",
  "circle",
  "geocode",
]);
const SCALAR_CAP = new Set([
  "audience",
  "restriction",
  "addresses",
  "identifier",
  "sender",
  "sent",
  "status",
  "msgType",
  "scope",
  "source",
  "note",
  "references",
  "incidents",
  "language",
  "event",
  "urgency",
  "severity",
  "certainty",
  "effective",
  "onset",
  "expires",
  "senderName",
  "headline",
  "description",
  "instruction",
  "web",
  "contact",
  "valueName",
  "value",
  "areaDesc",
  "polygon",
  "circle",
  "altitude",
  "ceiling",
  "code",
  "category",
  "responseType",
  "resourceDesc",
  "mimeType",
  "size",
  "uri",
  "derefUri",
  "digest",
]);

// Native CAP structure is strict; the shared decoder deliberately remains tolerant.
const CONTAINERS: Record<string, readonly string[]> = {
  alert: [
    "identifier",
    "sender",
    "sent",
    "status",
    "msgType",
    "source",
    "scope",
    "restriction",
    "addresses",
    "code",
    "note",
    "references",
    "incidents",
    "info",
  ],
  info: [
    "language",
    "category",
    "event",
    "responseType",
    "urgency",
    "severity",
    "certainty",
    "audience",
    "eventCode",
    "effective",
    "onset",
    "expires",
    "senderName",
    "headline",
    "description",
    "instruction",
    "web",
    "contact",
    "parameter",
    "resource",
    "area",
  ],
  parameter: ["valueName", "value"],
  eventCode: ["valueName", "value"],
  geocode: ["valueName", "value"],
  area: ["areaDesc", "polygon", "circle", "geocode", "altitude", "ceiling"],
  resource: ["resourceDesc", "mimeType", "size", "uri", "derefUri", "digest"],
};
const REQUIRED: Record<string, readonly string[]> = {
  alert: ["identifier", "sender", "sent", "status", "msgType", "scope"],
  info: ["category", "event", "urgency", "severity", "certainty"],
  parameter: ["valueName", "value"],
  eventCode: ["valueName", "value"],
  geocode: ["valueName", "value"],
  area: ["areaDesc"],
  resource: ["resourceDesc", "mimeType"],
};

/** Resolve every element against its in-scope namespaces before discarding prefixes. */
function normalized(
  nodes: Node[],
  inherited: Record<string, string> = {},
  depth = 0,
  cap = false,
): Node[] {
  if (depth > 24) throw new Error("RFS: XML nesting limit");
  return nodes.flatMap((node) => {
    const name = Object.keys(node).find((k) => k !== ":@");
    if (!name || name.startsWith("?") || name === "#comment") return [];
    if (name === "#text") return [node];
    const ns = { ...inherited };
    const attrs = node[":@"];
    if (isRecord(attrs))
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "@_xmlns") ns[""] = String(v);
        else if (k.startsWith("@_xmlns:")) ns[k.slice(8)] = String(v);
        else throw new Error("RFS: unexpected XML attribute");
      }
    const parts = name.split(":");
    const local = parts.at(-1)!;
    const inCap = cap || local === "alert";
    const uri = ns[parts.length === 1 ? "" : parts[0]!];
    if (uri !== (inCap ? CAP_1_2_NAMESPACE : DE)) throw new Error("RFS: foreign XML namespace");
    const children = node[name];
    if (!Array.isArray(children)) throw new Error("RFS: malformed XML element");
    const values = normalized(children as Node[], ns, depth + 1, inCap);
    if (inCap) {
      const seen = new Set<string>();
      for (const value of values) {
        const key = Object.keys(value)[0] ?? "";
        if (seen.has(key) && !REPEATED_CAP.has(key))
          throw new Error("RFS: duplicate CAP singleton");
        seen.add(key);
      }
      if (SCALAR_CAP.has(local)) {
        if (values.length > 1 || values.some((v) => typeof v["#text"] !== "string"))
          throw new Error("RFS: non-scalar CAP value");
      } else {
        const allowed = CONTAINERS[local];
        if (!allowed) throw new Error("RFS: unknown CAP container");
        only(values, allowed);
        if (
          ["parameter", "eventCode", "geocode"].includes(local) &&
          !text(values, "valueName").trim()
        )
          throw new Error("RFS: empty CAP pair name");
        for (const required of REQUIRED[local] ?? []) {
          if (!values.some((v) => required in v)) throw new Error(`RFS: missing CAP ${required}`);
        }
      }
    }
    return [{ [local]: values }];
  });
}
function children(node: Node, key: string): Node[] {
  const value = node[key];
  if (!Array.isArray(value)) throw new Error(`RFS: missing ${key}`);
  return value as Node[];
}
function only(nodes: Node[], allowed: readonly string[]): void {
  if (nodes.some((n) => Object.keys(n).some((key) => !allowed.includes(key))))
    throw new Error("RFS: unaccounted distribution content");
}
function one(nodes: Node[], key: string): Node {
  const matches = nodes.filter((n) => key in n);
  if (matches.length !== 1) throw new Error(`RFS: expected one ${key}`);
  return matches[0]!;
}
function text(nodes: Node[], key: string): string {
  const value = children(one(nodes, key), key);
  if (value.length !== 1 || typeof value[0]?.["#text"] !== "string")
    throw new Error(`RFS: invalid ${key}`);
  return value[0]["#text"];
}

export function parseNswRfs(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const bodies = payloads["alerts"];
  if (bodies?.length !== 1 || bodies[0]!.length > MAX_BYTES)
    throw new Error("RFS: bounded single distribution required");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bodies[0]);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("RFS: malformed XML");
  const roots = normalized(parser.parse(xml) as Node[]);
  if (roots.length !== 1) throw new Error("RFS: single distribution required");
  const root = children(one(roots, "EDXLDistribution"), "EDXLDistribution");
  only(root, [
    "distributionID",
    "senderID",
    "dateTimeSent",
    "distributionStatus",
    "distributionType",
    "combinedConfidentiality",
    "language",
    "targetArea",
    "contentObject",
  ]);
  // Screen all decoded source text before terminal/excluded records or fields can disappear.
  if (/all rights reserved|no redistribution|not for redistribution/i.test(JSON.stringify(root)))
    throw new Error("RFS: expressly restricted material");
  const published = capInstant(text(root, "dateTimeSent"));
  const now = Date.parse(ctx.fetchedAt);
  if (
    !published ||
    !Number.isFinite(now) ||
    now - Date.parse(published) > MAX_AGE_MS ||
    Date.parse(published) > now + 300_000
  )
    throw new Error("RFS: source publication is not fresh");
  if (
    text(root, "senderID") !== SENDER ||
    text(root, "distributionStatus") !== "Actual" ||
    text(root, "distributionType") !== "Report"
  )
    throw new Error("RFS: unsupported distribution");
  text(root, "distributionID");
  const objects = root.filter((n) => "contentObject" in n);
  if (objects.length > 2000) throw new Error("RFS: incident limit");
  const out: ParseOutput = {
    situations: [],
    features: [],
    observations: [],
    offers: [],
    snapshotQualified: feed.rfsCurrentSnapshotQualified === true,
  };
  let terminal = 0;
  let duplicates = 0;
  const seen = new Map<string, string>();
  const candidates: CapAlert[] = [];
  const draftsByMessage = new Map<string, ParseOutput["situations"][number]>();
  for (const object of objects) {
    const content = children(object, "contentObject");
    only(content, ["contentDescription", "xmlContent"]);
    const xmlContent = children(one(content, "xmlContent"), "xmlContent");
    only(xmlContent, ["embeddedXMLContent"]);
    const embedded = children(one(xmlContent, "embeddedXMLContent"), "embeddedXMLContent");
    if (embedded.length !== 1) throw new Error("RFS: partial content object");
    const element = one(embedded, "alert");
    const alert = readCapXml(
      Buffer.from(
        builder.build([
          { alert: children(element, "alert"), ":@": { "@_xmlns": CAP_1_2_NAMESPACE } },
        ]),
      ),
    ) as CapAlert;
    if (
      alert.sender !== SENDER ||
      !/^\d+$/.test(alert.incidents ?? "") ||
      !capInstant(alert.sent) ||
      Date.parse(alert.sent) > now + 300_000 ||
      alert.status !== "Actual" ||
      alert.scope !== "Public" ||
      !["Alert", "Update", "Cancel"].includes(alert.msgType)
    )
      throw new Error("RFS: invalid CAP identity/header");
    if (
      (alert.info ?? [])
        .flatMap((i) => i.resource ?? [])
        .some(
          (r) =>
            r.mimeType !== "text/html" ||
            r.uri !== "https://www.rfs.nsw.gov.au/fire-information/fires-near-me",
        )
    )
      throw new Error("RFS: unqualified resource rights");
    const signature = JSON.stringify(alert);
    if (seen.has(alert.identifier)) {
      if (seen.get(alert.identifier) !== signature) throw new Error("RFS: conflicting duplicate");
      duplicates++;
      continue;
    }
    seen.set(alert.identifier, signature);
    candidates.push(alert);
    if (alert.msgType !== "Alert") {
      const refs = typeof alert.references === "string" ? capReferences(alert.references) : [];
      if (
        refs.length === 0 ||
        alert.references!.trim().split(/\s+/).length !== refs.length ||
        refs.some(
          (r) =>
            r.sender !== SENDER ||
            r.identifier === alert.identifier ||
            !capInstant(r.sent) ||
            Date.parse(r.sent) > Date.parse(alert.sent),
        )
      )
        throw new Error("RFS: invalid lifecycle references");
      if (alert.msgType === "Cancel" && (!alert.info || alert.info.length === 0)) {
        terminal++;
        continue;
      }
    }
    if (!Array.isArray(alert.info) || alert.info.length !== 1)
      throw new Error("RFS: missing/ambiguous incident info");
    const info = alert.info[0]!;
    const parameter = (key: string) => {
      const values = (info.parameter ?? []).filter((p) => p.valueName === key);
      if (values.length !== 1 || typeof values[0]!.value !== "string" || !values[0]!.value.trim())
        throw new Error(`RFS: missing/ambiguous ${key}`);
      return values[0]!.value;
    };
    const type = parameter("IncidentType");
    const fire = parameter("IsFire");
    if (!["Yes", "No"].includes(fire)) throw new Error("RFS: unknown IsFire");
    const expiry = capInstant(info.expires);
    if (!expiry) throw new Error("RFS: missing expiry");
    if (!["Bush Fire", "Grass Fire"].includes(type)) {
      if (
        ![
          "Planned Event",
          "Haystack fire",
          "Other",
          "Fire Alarm",
          "Vehicle/Equipment Fire",
          "Structure Fire",
          "Truck Fire",
          "MVA/Transport",
          "Assist Other Agency",
        ].includes(type)
      )
        throw new Error("RFS: unknown IncidentType");
      terminal++;
      continue;
    }
    const native = (info.eventCode ?? []).filter(
      (e) => e.valueName === "https://govshare.gov.au/xmlui/handle/10772/6495",
    );
    if (
      native.length !== 1 ||
      native[0]!.value !== (type === "Bush Fire" ? "bushFire" : "grassFire")
    )
      throw new Error("RFS: missing/unknown CAP-AU wildfire code");
    if (fire !== "Yes") throw new Error("RFS: contradictory wildfire semantics");
    if (Date.parse(expiry) <= now) {
      terminal++;
      continue;
    }
    if (info.area?.length !== 1 || info.area.some((a) => a.circle?.length !== 1))
      throw new Error("RFS: missing incident anchor");
    const projected = structuredClone(alert);
    // Never project a polygon or positive-radius circle as an incident footprint.
    for (const a of projected.info![0]!.area!) {
      if (a.circle!.some((c) => !/^\s*-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?\s+0(?:\.0+)?\s*$/.test(c)))
        throw new Error("RFS: unsupported incident anchor");
      a.polygon = [];
    }
    const result = capDrafts(projected, feed, {
      groupId: `nsw-rfs:${SENDER}:${alert.incidents}`,
      fetchedAt: ctx.fetchedAt,
      expiresAt: (end) =>
        new Date(Math.min(Date.parse(end!), Date.parse(published) + MAX_AGE_MS)).toISOString(),
    });
    if (Object.values(result.skipped).some((n) => n > 0) || result.drafts.length !== 1)
      throw new Error("RFS: incomplete semantic acceptance");
    const draft = result.drafts[0]!;

    const location = draft["location"] as Record<string, unknown>;
    location["fuzziness"] = /unmapped incident/i.test(
      JSON.stringify([info.headline, info.area, info.parameter]),
    )
      ? "low_res"
      : "extent_unknown";
    draftsByMessage.set(alert.identifier, draft);
  }
  const byId = new Map(candidates.map((a) => [a.identifier, a]));
  for (const alert of candidates) {
    for (const ref of capReferences(typeof alert.references === "string" ? alert.references : "")) {
      const parent = byId.get(ref.identifier);
      if (parent && (parent.incidents !== alert.incidents || parent.sent !== ref.sent))
        throw new Error("RFS: conflicting incident reference");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (alert: CapAlert): void => {
    if (visiting.has(alert.identifier)) throw new Error("RFS: cyclic lifecycle references");
    if (visited.has(alert.identifier)) return;
    visiting.add(alert.identifier);
    for (const ref of capReferences(alert.references ?? "")) {
      const parent = byId.get(ref.identifier);
      if (parent) visit(parent);
    }
    visiting.delete(alert.identifier);
    visited.add(alert.identifier);
  };
  for (const alert of candidates) visit(alert);
  const incidents = new Set<string>();
  for (const alert of currentMessages(candidates).current) {
    if (incidents.has(alert.incidents!)) throw new Error("RFS: conflicting incident revisions");
    incidents.add(alert.incidents!);
    const draft = draftsByMessage.get(alert.identifier);
    if (draft) out.situations.push(draft);
  }
  terminal = seen.size - out.situations.length;
  accountSituations(out, { inputCount: objects.length, duplicates, rejected: 0, terminal });
  return out;
}
