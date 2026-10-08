import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { haversineMetres, houseNumbersDiffer, observationId } from "@openconditions/model";
import { detached } from "./records.js";
import { connectorKey, evseKey } from "./site.js";

/** Locations of one operator this close are one site. */
const SAME_SITE_METRES = 15;

/** Degrees of latitude per metre, near enough for a grid of 15 m cells. */
const LAT_PER_METRE = 1 / 111_195;

type Rec = Record<string, unknown>;

interface Component {
  key: string;
  parentKey?: string;
  kind: string;
  lifecycle?: string;
  externalIds?: { scheme: string; id: string }[];
}

interface Member {
  draft: RecordDraft;
  stationId: string;
  point: [number, number];
  address: { street?: string; houseNumber?: string };
}

const record = (value: unknown): Rec =>
  typeof value === "object" && value !== null ? (value as Rec) : {};

/** The id that issued a site's own id: its provider id's authority, else none. */
function issuerOf(draft: RecordDraft): string {
  const ids = (draft["externalIds"] ?? []) as { scheme: string; authority?: string }[];
  return ids.find((e) => e.scheme === "provider")?.authority ?? "";
}

function operatorOf(draft: RecordDraft): string | undefined {
  const name = (record(draft["operator"])["name"] ?? []) as { text: string }[];
  const text = name[0]?.text.trim().replace(/\s+/g, " ").toLowerCase();
  return text === undefined || text === "" ? undefined : text;
}

function memberOf(draft: RecordDraft): Member | undefined {
  const location = record(draft["location"]);
  const coordinates = record(location["geometry"])["coordinates"];
  const stationId = record(draft["provenance"])["recordId"];
  if (!Array.isArray(coordinates) || typeof stationId !== "string") return undefined;
  return {
    draft,
    stationId,
    point: [Number(coordinates[0]), Number(coordinates[1])],
    address: record(location["address"]) as Member["address"],
  };
}

const byId = (a: Member, b: Member) =>
  a.stationId.localeCompare(b.stationId, "en", { numeric: true });

/** Whether two locations may be one site: close enough, and not two house numbers. */
const together = (a: Member, b: Member) =>
  haversineMetres(a.point, b.point) <= SAME_SITE_METRES &&
  !houseNumbersDiffer(a.address, b.address);

/**
 * The groups of `members` (one issuer's, one operator's) that are one site
 * each: in id order, a location joins the first group whose every member
 * stands with it, so a group never stretches past 15 m however its members
 * line up. Members are found through a grid of cells 15 m of latitude high
 * and as many degrees wide everywhere; away from the equator 15 m of
 * longitude spans more columns, and the search widens to cover them.
 */
function groupsOf(members: Member[]): Member[][] {
  members.sort(byId);
  const groups: Member[][] = [];
  const cells = new Map<string, Member[][]>();
  const CELL_DEG = SAME_SITE_METRES * LAT_PER_METRE;
  for (const member of members) {
    const [lon, lat] = member.point;
    const x = Math.floor(lon / CELL_DEG);
    const y = Math.floor(lat / CELL_DEG);
    const span = Math.ceil(1 / Math.max(0.01, Math.cos(((Math.abs(lat) + 0.01) * Math.PI) / 180)));
    const near = new Set<Member[]>();
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const group of cells.get(`${x + dx},${y + dy}`) ?? []) near.add(group);
      }
    }
    // Groups open in id order, so the earliest is the one of the lowest id.
    let joined = [...near]
      .filter((group) => group.every((m) => together(m, member)))
      .sort((a, b) => groups.indexOf(a) - groups.indexOf(b))[0];
    if (joined === undefined) {
      joined = [];
      groups.push(joined);
    }
    joined.push(member);
    const key = `${x},${y}`;
    const inCell = cells.get(key) ?? [];
    if (!inCell.includes(joined)) cells.set(key, [...inCell, joined]);
  }
  return groups;
}

/** The value every draft states alike, absent ones included; undefined when they differ. */
function shared(drafts: readonly RecordDraft[], of: (d: RecordDraft) => unknown): unknown {
  const values = drafts.map((d) => of(d));
  const written = values.map((v) => JSON.stringify(v ?? null));
  return written.every((v) => v === written[0]) ? values[0] : undefined;
}

const first = (drafts: readonly RecordDraft[], of: (d: RecordDraft) => unknown): unknown =>
  drafts.map(of).find((v) => v !== undefined);

function union<T>(lists: readonly (readonly T[] | undefined)[]): T[] {
  const seen = new Map<string, T>();
  for (const value of lists.flatMap((l) => l ?? [])) seen.set(JSON.stringify(value), value);
  return [...seen.values()];
}

function accessOf(drafts: readonly RecordDraft[]): Rec | undefined {
  const accesses = drafts.map((d) => record(d["access"]));
  const payment = union(accesses.map((a) => a["payment"] as string[] | undefined));
  const authentication = union(accesses.map((a) => a["authentication"] as string[] | undefined));
  const audience = shared(drafts, (d) => record(d["access"])["audience"]) as string | undefined;
  if (audience === undefined && payment.length === 0 && authentication.length === 0) {
    return undefined;
  }
  return {
    audience: audience ?? "unknown",
    ...(payment.length === 0 ? {} : { payment }),
    ...(authentication.length === 0 ? {} : { authentication }),
  };
}

/** A component key moved under its location's id: `<stationId>:<key>`. */
const prefixed = (stationId: string, key: string) => `${evseKey(stationId)}:${key}`;

const emi3Of = (c: Component) => c.externalIds?.find((e) => e.scheme === "emi3:evse")?.id;

/**
 * The charge points of every member, the first's keys as they are. A later
 * member's charge point whose key is taken is the same one when both carry
 * the same eMI3 id (kept once), else keyed under its location's id with its
 * connectors. Returns the components and each member's key changes.
 */
function mergeComponents(group: readonly Member[], lifecycles: (string | undefined)[]) {
  const out: Component[] = [];
  const taken = new Map<string, Component>();
  const renamed = new Map<string, Map<string, string>>();
  const mixed = lifecycles.some((l) => l !== lifecycles[0]);
  group.forEach((member, i) => {
    const own = (member.draft["components"] ?? []) as Component[];
    const keys = new Map<string, string>();
    const dropped = new Set<string>();
    for (const c of own.filter((c) => c.parentKey === undefined)) {
      const held = taken.get(c.key);
      if (held === undefined) continue;
      const emi3 = emi3Of(c);
      if (emi3 !== undefined && emi3 === emi3Of(held)) dropped.add(c.key);
      else keys.set(c.key, prefixed(member.stationId, c.key));
    }
    const keyOf = (key: string) => {
      const [parent = "", ...rest] = key.split("/");
      const moved = keys.get(parent);
      return moved === undefined ? key : [moved, ...rest].join("/");
    };
    for (const c of own) {
      const top = c.parentKey ?? c.key;
      if (dropped.has(top)) continue;
      const key = keyOf(c.key);
      const lifecycle = lifecycles[i];
      const component: Component = {
        ...c,
        key,
        ...(c.parentKey === undefined ? {} : { parentKey: keyOf(c.parentKey) }),
        ...(mixed && c.kind === "evse" && c.lifecycle === undefined && lifecycle !== undefined
          ? { lifecycle }
          : {}),
      };
      taken.set(key, component);
      out.push(component);
    }
    renamed.set(member.draft["id"] as string, new Map([...own].map((c) => [c.key, keyOf(c.key)])));
  });
  return { components: out, renamed };
}

/** One site of a group's drafts, the lead (lowest id) giving its id, point and provenance. */
function merge(lead: Member, group: readonly Member[]) {
  const drafts = group.map((m) => m.draft);
  const base = lead.draft;
  const lifecycles = drafts.map((d) => d["lifecycle"] as string | undefined);
  const lifecycle = lifecycles.includes("operational") ? "operational" : lifecycles[0];
  const { components, renamed } = mergeComponents(group, lifecycles);
  const location = record(base["location"]);
  const address = first(drafts, (d) => record(d["location"])["address"]);
  const name = first(drafts, (d) => d["name"]);
  const description = first(drafts, (d) => d["description"]);
  const owner = first(drafts, (d) => d["owner"]);
  const openingHours = shared(drafts, (d) => d["openingHours"]);
  const access = accessOf(drafts);
  const amenities = union(drafts.map((d) => d["amenities"] as string[] | undefined));
  const upstream = union(drafts.map((d) => record(d["provenance"])["upstream"] as Rec[]));
  const details = record(base["details"]);
  const detail = (field: string, how: typeof shared) =>
    how(drafts, (d) => record(d["details"])[field]);
  const merged: RecordDraft = {
    ...Object.fromEntries(
      Object.entries(base).filter(
        ([k]) =>
          !["name", "description", "owner", "openingHours", "access", "amenities"].includes(k),
      ),
    ),
    lifecycle,
    location: {
      ...Object.fromEntries(Object.entries(location).filter(([k]) => k !== "address")),
      ...(address === undefined ? {} : { address }),
    },
    provenance: {
      ...record(base["provenance"]),
      ...(upstream.length === 0 ? {} : { upstream }),
    },
    externalIds: union(drafts.map((d) => d["externalIds"] as Rec[])),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(owner === undefined ? {} : { owner }),
    ...(openingHours === undefined || openingHours === null ? {} : { openingHours }),
    ...(access === undefined ? {} : { access }),
    ...(amenities.length === 0 ? {} : { amenities }),
    ...(components.length === 0 ? {} : { components }),
    details: Object.fromEntries(
      Object.entries({
        kind: details["kind"],
        v: details["v"],
        parkingType: detail("parkingType", shared),
        brand: detail("brand", first),
        website: detail("website", first),
        tariffText: detail("tariffText", first),
        openingHoursText: detail("openingHoursText", shared),
      }).filter(([, v]) => v !== undefined && v !== null),
    ),
  };
  return { merged, renamed };
}

/** A reading moved onto the site `featureId` (and its component), with the id that gives it. */
export function movedReading(
  o: RecordDraft,
  featureId: string,
  componentKey: string | undefined,
): RecordDraft {
  const subject = record(o["subject"]);
  const { id: _id, ...rest } = o;
  const moved: Rec = {
    ...rest,
    subject: { ...subject, featureId, ...(componentKey === undefined ? {} : { componentKey }) },
  };
  const id = observationId(record(o["provenance"])["sourceId"] as string, moved as never);
  return { id, ...moved };
}

/**
 * Makes one site of a feed's own locations that one operator published
 * within 15 m of each other: publishers list a location per charger at one
 * car park, and two sites of one source never link afterwards. Two locations
 * stay apart when their house numbers differ, when two issuers of one
 * aggregator issued them, or when either names no operator. The site takes
 * the lowest location id (numbers compared as numbers) with every location's
 * ids as its own; readings and offers move onto it, as do the status
 * index's subjects of its locations, and a charge point key another location
 * already uses is put under its location's id.
 */
export function colocateSites(out: ParseOutput): ParseOutput {
  const candidates = new Map<string, Member[]>();
  for (const draft of out.features) {
    const operator = operatorOf(draft);
    const member = memberOf(draft);
    if (operator === undefined || member === undefined) continue;
    const key = `${issuerOf(draft)}\u0000${operator}`;
    const held = candidates.get(key);
    if (held === undefined) candidates.set(key, [member]);
    else held.push(member);
  }
  const replaced = new Map<string, RecordDraft | null>();
  const keys = new Map<string, Map<string, string>>();
  const siteOf = new Map<string, string>();
  const memberOfStation = new Map<string, string>();
  for (const members of candidates.values()) {
    if (members.length < 2) continue;
    for (const group of groupsOf(members)) {
      const [lead] = group;
      if (lead === undefined || group.length < 2) continue;
      const { merged, renamed } = merge(lead, group);
      const id = merged["id"] as string;
      replaced.set(id, merged);
      for (const m of group.slice(1)) replaced.set(m.draft["id"] as string, null);
      for (const m of group) memberOfStation.set(m.stationId, m.draft["id"] as string);
      for (const [member, moves] of renamed) {
        keys.set(member, moves);
        siteOf.set(member, id);
      }
    }
  }
  if (replaced.size === 0) return out;
  // A status the index places on a merged station lands where its readings do.
  for (const subjects of out.statusIndex?.values() ?? []) {
    for (const subject of subjects) {
      const member = memberOfStation.get(subject.stationId);
      const site = member === undefined ? undefined : siteOf.get(member);
      if (member === undefined || site === undefined) continue;
      const evse = subject.evseKey ?? "";
      const key =
        subject.connectorId === undefined ? evseKey(evse) : connectorKey(evse, subject.connectorId);
      subject.featureId = detached(site);
      subject.componentKey = detached(keys.get(member)?.get(key) ?? key);
    }
  }
  out.features = out.features.flatMap((d) => {
    const next = replaced.get(d["id"] as string);
    return next === undefined ? [d] : next === null ? [] : [next];
  });
  const seen = new Set<string>();
  out.observations = out.observations.flatMap((o) => {
    const subject = record(o["subject"]);
    const member = subject["featureId"] as string | undefined;
    const site = member === undefined ? undefined : siteOf.get(member);
    if (member === undefined || site === undefined) return [o];
    const componentKey = subject["componentKey"] as string | undefined;
    const moved = movedReading(
      o,
      site,
      componentKey === undefined
        ? undefined
        : (keys.get(member)?.get(componentKey) ?? componentKey),
    );
    const id = moved["id"] as string;
    if (seen.has(id)) return [];
    seen.add(id);
    return [moved];
  });
  for (const offer of out.offers) {
    const subject = record(offer["subject"]);
    const site = siteOf.get(subject["id"] as string);
    if (site !== undefined) offer["subject"] = { ...subject, id: site };
  }
  return out;
}
