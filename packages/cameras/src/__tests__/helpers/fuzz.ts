import {
  draftProblems,
  fuzzParameters,
  type JsonMutationOptions,
  type Mutation,
  mutateJson,
  mutateXml,
  mutations,
  type XmlMutationOptions,
} from "@openconditions/conformance";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  skippedRecords,
} from "@openconditions/ingest-framework";
import fc from "fast-check";
import { expect } from "vitest";
import { camerasDomain } from "../../domain.js";
import { catalogFeed, parseContext } from "./cameras-feed.js";
import { sealFailures } from "./seal.js";

const FETCHED = "2026-10-08T07:16:00Z";

/** One camera format's fixture, the payload role it is served as, and how its records are counted. */
export interface FuzzCase<D> {
  feed: string;
  role: string;
  /** The fixture: a JSON document, or XML text. */
  base: D;
  /** The poll's other payloads, left as captured. */
  others?: FeedPayloads;
  /**
   * The ids of the source records a document holds, each of which becomes a
   * camera or is counted as skipped: undefined for a record without a usable
   * id. Records repeating an id are one camera.
   */
  records?: (doc: D) => readonly (string | undefined)[];
  runs?: number;
}

/** A record's id as the parsers read one: trimmed text, or a finite number's decimal text. */
export function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** What one parse gave, checked: it did not throw, every draft seals and is plain, valid data. */
function parsed(feedId: string, payloads: FeedPayloads, applied: readonly string[]) {
  __resetSkips();
  const feed = catalogFeed(feedId);
  let out: ParseOutput;
  try {
    out = camerasDomain.formats[feed.format]!.parse(feed, payloads, parseContext(FETCHED));
  } catch (error) {
    throw new Error(`threw after ${JSON.stringify(applied)}: ${(error as Error).stack}`);
  }
  const drafts = [...out.features, ...out.observations, ...out.offers];
  expect(sealFailures(drafts), JSON.stringify(applied)).toEqual([]);
  expect(draftProblems(drafts), JSON.stringify(applied)).toEqual([]);
  return { out, skipped: skippedRecords(drainSkipped(feed.id)) };
}

/**
 * No record is lost unseen: each distinct record became a camera, or was
 * counted as skipped or rejected, and no record became two cameras. The
 * counts may hold more, as a camera's views and presets are records of their
 * own and a dropped image is rejected.
 */
function accounted(
  ids: readonly (string | undefined)[] | undefined,
  { out, skipped }: ReturnType<typeof parsed>,
  applied: readonly string[],
) {
  if (ids === undefined) return;
  const records =
    new Set(ids.filter((id) => id !== undefined)).size +
    ids.filter((id) => id === undefined).length;
  const cameras = new Set(out.features.map((f) => f["id"])).size;
  const what = JSON.stringify(applied);
  expect(cameras, what).toBeLessThanOrEqual(records);
  expect(cameras + skipped + (out.rejected ?? 0), what).toBeGreaterThanOrEqual(records);
}

/** Mutated copies of a JSON fixture through the real parser. */
export function fuzzJson(
  c: FuzzCase<unknown>,
  options: JsonMutationOptions & { keepTypes?: boolean },
): void {
  fc.assert(
    fc.property(mutations({ keepTypes: options.keepTypes ?? false }), (list: Mutation[]) => {
      const { doc, applied } = mutateJson(c.base, list, options);
      const result = parsed(
        c.feed,
        { ...c.others, [c.role]: [Buffer.from(JSON.stringify(doc))] },
        applied,
      );
      accounted(c.records?.(doc), result, applied);
    }),
    fuzzParameters(c.runs ?? 150),
  );
}

/**
 * The elements of one qualified name, start tag to end tag, in document
 * order: the fixtures do not nest an element in one of the same name.
 */
export const elements = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g"))].map((m) => m[0]);

/** The text of an element's first child of one qualified name. */
export const childText = (element: string, name: string): string | undefined =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(element)?.[1];

/** Mutated copies of an XML fixture through the real parser. */
export function fuzzXml(c: FuzzCase<string>, options: XmlMutationOptions): void {
  fc.assert(
    fc.property(mutations(), (list: Mutation[]) => {
      const { xml, applied } = mutateXml(c.base, list, options);
      const result = parsed(c.feed, { ...c.others, [c.role]: [Buffer.from(xml)] }, applied);
      accounted(c.records?.(xml), result, applied);
    }),
    fuzzParameters(c.runs ?? 150),
  );
}
