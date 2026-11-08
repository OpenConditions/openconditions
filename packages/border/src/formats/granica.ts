import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { GRANICA_CROSSINGS } from "../granica-crossings.js";
import {
  type BorderFeed,
  crossingDraft,
  type LaneGroupInput,
  utcInstant,
  type WaitValue,
  waitDraft,
} from "../records.js";
import { wallClock } from "../time.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const fail = (why: string): never => {
  throw new Error(`granica: ${why}`);
};
const children = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);
const elements = (n: Node, tag: string): Element[] =>
  children(n).flatMap((c) => ("tagName" in c && c.tagName === tag ? [c] : elements(c, tag)));
const attr = (n: Element, key: string) => n.attrs.find((a) => a.name === key)?.value;
const text = (n: Node): string =>
  ("value" in n ? n.value : children(n).map(text).join(" ")).replace(/\s+/g, " ").trim();
const cells = (n: Node): Element[] =>
  children(n).filter((c): c is Element => "tagName" in c && ["td", "th"].includes(c.tagName));
const EXCLUDED = ["Dorohusk", "Zosin", "Dołhobyczów", "Budomierz", "Malhowice", "Krościenko"];

/** Polish-side wall time is an adapter interpretation. Reject folds, gaps and uncertain dates. */
export function granicaInstant(date: string, minute: string, fetchedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(minute))
    return fail("invalid publication date/minute");
  const wall = Date.parse(`${date}T${minute}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date)
    return fail("invalid date");
  // A previous-day page has no trustworthy date association for its per-crossing minutes.
  if (wallClock(new Date(fetchedAt), "Europe/Warsaw").date !== date)
    return fail("uncertain midnight date association");
  const matches = [wall - 3600000, wall - 7200000].filter((t) => {
    const w = wallClock(new Date(t), "Europe/Warsaw");
    return w.date === date && w.time === `${minute}:00`;
  });
  if (matches.length !== 1 || matches[0]! > Date.parse(fetchedAt))
    return fail("ambiguous, nonexistent or future publication");
  return utcInstant(new Date(matches[0]!));
}

function readWait(cell: Element, commercial: boolean): WaitValue | undefined {
  if (/^(?:>7,5T DMC\s+)?(?:ruch zawieszony|zawieszony)$/i.test(text(cell)))
    return { status: "closed" };
  if (attr(cell, "bgcolor")?.toLowerCase() === "#cccccc" || text(cell) === "" || text(cell) === "-")
    return undefined;
  let value = text(cell);
  if (commercial) {
    if (!/^>7,5T DMC\s/.test(value)) return fail("unsupported freight class");
    value = value.replace(/^>7,5T DMC\s*/, "");
  }
  if (/^(?:ruch zawieszony|zawieszony)$/i.test(value)) return { status: "closed" };
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (!m) return fail("unreadable wait cell");
  const waitMinutes = Number(m[1]) * 60 + Number(m[2]);
  return { status: waitMinutes === 0 ? "no_delay" : "delay", waitMinutes };
}

/** One required, server-rendered official country table. No script execution or HTTP here. */
export function parseGranica(
  feed: BorderFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const buffers = payloads["main"];
  if (buffers?.length !== 1 || buffers[0]!.length > 2_000_000)
    return fail("one bounded country page required");
  const document = parse(buffers[0]!.toString("utf8"), { sourceCodeLocationInfo: true });
  const tables = elements(document, "table").filter((t) =>
    attr(t, "class")?.split(/\s+/).includes("border-table"),
  );
  if (tables.length !== 1) return fail("missing or duplicate country table");
  const table = tables[0]!;
  if (!table.sourceCodeLocation?.endTag) return fail("truncated table");
  if (!text(table).includes("WYJAZD Z RP") || !text(table).includes("Ukraina"))
    return fail("wrong country/direction");
  const dates = [...text(table).matchAll(/Stan na:\s*(\d{4})-(\d{1,2})-(\d{1,2})/g)];
  if (dates.length !== 1) return fail("missing/ambiguous date");
  const d = dates[0]!;
  const date = `${d[1]}-${d[2]!.padStart(2, "0")}-${d[3]!.padStart(2, "0")}`;
  const rows = elements(table, "tr");
  const headerRows = rows.filter((r) =>
    cells(r).some((c) => GRANICA_CROSSINGS.some((x) => x.aliases.includes(text(c)))),
  );
  if (headerRows.length !== 1) return fail("missing/ambiguous crossing header");
  const headerCells = cells(headerRows[0]!);
  const unspanned = (cs: Element[]) =>
    cs.every(
      (c) =>
        [undefined, "1"].includes(attr(c, "colspan")) &&
        [undefined, "1"].includes(attr(c, "rowspan")),
    );
  if (!unspanned(headerCells)) return fail("ambiguous spanned header");
  const headers = headerCells.map(text);
  if (
    new Set(headers).size !== headers.length ||
    headers.some(
      (h) => !EXCLUDED.includes(h) && !GRANICA_CROSSINGS.some((x) => x.aliases.includes(h)),
    )
  )
    return fail("unknown or duplicate crossing header");
  const indexes = GRANICA_CROSSINGS.map((c) => {
    const found = headers.flatMap((h, i) => (c.aliases.includes(h) ? [i] : []));
    if (found.length !== 1) return fail("missing or ambiguous unit reference");
    return found[0]!;
  });
  const classRows = new Map<string, Element[]>();
  let updated: Element[] | undefined;
  for (const row of rows) {
    const cs = cells(row);
    if (!cs.length) continue;
    if (text(cs[0]!).startsWith("Godzina aktualizacji:")) {
      if (updated) return fail("duplicate update row");
      updated = cs.slice(1);
    }
    const images = elements(cs[0]!, "img");
    if (!images.length || !text(cs[0]!).includes("Szacunkowy czas oczekiwania")) continue;
    const label = attr(images[0]!, "alt");
    const kind =
      label === "obrazek  samochody CIĘŻAROWE"
        ? "commercial"
        : label === "obrazek  samochody OSOBOWE"
          ? "passenger"
          : label === "obrazek  AUTOKARY"
            ? "bus"
            : fail("unsupported class row");
    if (classRows.has(kind)) return fail("duplicate class row");
    classRows.set(kind, cs.slice(1));
  }
  if (
    !updated ||
    updated.length !== headers.length ||
    !unspanned(updated) ||
    !classRows.has("passenger") ||
    !classRows.has("commercial") ||
    [...classRows.values()].some((cs) => cs.length !== headers.length || !unspanned(cs))
  )
    return fail("partial table");
  const out = emptyParseOutput();
  for (const [i, crossing] of GRANICA_CROSSINGS.entries()) {
    const column = indexes[i]!;
    const at = granicaInstant(date, text(updated[column]!), ctx.fetchedAt);
    const lanes: LaneGroupInput[] = [
      {
        key: "pl-ua-car",
        mode: "passenger",
        vehicleClass: "car",
        direction: { from: "PL", to: "UA" },
      },
      {
        key: "pl-ua-dmc-gt7500",
        mode: "commercial",
        vehicleClass: "hgv",
        direction: { from: "PL", to: "UA" },
        eligibility: {
          maximumPermissibleGrossMass: { operator: "gt", value: { value: 7500, unit: "kg" } },
          sourceWording: [{ lang: "pl", text: ">7,5T DMC — dopuszczalna masa całkowita" }],
        },
      },
    ];
    const feature = crossingDraft(
      feed,
      crossing,
      {
        localId: crossing.unit,
        recordId: crossing.unit,
        name: crossing.name,
        country: "PL",
        portIds: [{ scheme: "provider", id: crossing.unit, authority: "granica.gov.pl" }],
        lanes,
        modes: ["passenger", "commercial"],
      },
      ctx.fetchedAt,
    );
    feature.provenance["upstream"] = [
      {
        publisher: "Wikidata",
        recordId: `${crossing.wikidata}@${crossing.revision}`,
        license: "CC0-1.0",
        attribution: `Structured coordinate location; https://www.wikidata.org/w/index.php?title=${crossing.wikidata}&oldid=${crossing.revision}; retrieved ${crossing.retrievedAt} (${crossing.evidence}); https://www.wikidata.org/wiki/Wikidata:Licensing`,
      },
    ];
    out.features.push(feature);
    for (const lane of lanes) {
      const value = readWait(classRows.get(lane.mode)![column]!, lane.mode === "commercial");
      if (value === undefined) {
        recordSkipped(feed.id, "unknown_value");
        continue;
      }
      const observation = waitDraft(feature, lane.key, value, at);
      observation["freshness"] = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: utcInstant(new Date(Date.parse(at) + 7200000)),
      };
      out.observations.push(observation);
    }
  }
  return out;
}
