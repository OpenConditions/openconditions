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
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
  type SkipCounts,
  skippedRecords,
} from "@openconditions/ingest-framework";
import fc from "fast-check";
import { chargingDomain } from "../../domain.js";
import { catalogFeed, parseContext } from "./charging-feed.js";
import { sealFailures } from "./seal.js";

const FETCHED = "2026-10-17T08:00:00Z";

type Rec = Record<string, unknown>;

/** One parse of a feed's payloads by its format, with the skips it recorded. */
export interface Parsed {
  out: ParseOutput;
  skips: SkipCounts;
}

/** The real format of a catalogue feed over the payloads, as a poll runs it. */
export function parseFeed(feedId: string, payloads: FeedPayloads): Parsed {
  const feed = catalogFeed(feedId);
  drainSkipped(feed.id);
  const out = chargingDomain.formats[feed.format]!.parse(feed, payloads, parseContext(FETCHED));
  return { out, skips: drainSkipped(feed.id) };
}

/** A site's provider ids: one per source record, also once colocation has merged several. */
export const providerIds = (out: ParseOutput): number =>
  out.features.reduce(
    (n, f) =>
      n +
      ((f["externalIds"] ?? []) as { scheme: string }[]).filter((e) => e.scheme === "provider")
        .length,
    0,
  );

/** The charge points of every site. */
export const evseComponents = (out: ParseOutput): number =>
  out.features.reduce(
    (n, f) =>
      n + ((f["components"] ?? []) as { kind: string }[]).filter((c) => c.kind === "evse").length,
    0,
  );

/**
 * What a parse got wrong: a record that does not seal, a value the drafts
 * cannot carry, and, where `accounting` says how many source records the
 * parse had to account for, fewer produced and counted than that.
 */
export function parseProblems(
  { out, skips }: Parsed,
  accounting?: { expected: number; produced: (out: ParseOutput) => number },
): string[] {
  const drafts: RecordDraft[] = [...out.features, ...out.observations, ...out.offers];
  const problems = [
    ...sealFailures(drafts).map(
      (f) => `${String(f.id)} does not seal: ${JSON.stringify(f.issues).slice(0, 400)}`,
    ),
    ...draftProblems(drafts),
  ];
  if (accounting !== undefined) {
    const produced = accounting.produced(out);
    const counted = skippedRecords(skips) + (out.rejected ?? 0);
    if (produced + counted < accounting.expected) {
      problems.push(
        `${accounting.expected} source records, ${produced} produced and ${counted} counted (${JSON.stringify(skips)})`,
      );
    }
  }
  return problems;
}

/** Fails, naming what was changed, when the problems are not none. */
function report(applied: readonly string[], problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(`after ${applied.join("; ")}:\n  ${problems.slice(0, 5).join("\n  ")}`);
  }
}

/**
 * Asserts `check` finds nothing wrong with any mutation of a JSON document.
 * `check` gets the mutated document; a parser that throws fails the run.
 */
export function fuzzJson(
  doc: unknown,
  options: JsonMutationOptions & { runs: number; keepTypes?: boolean },
  check: (mutated: Rec | unknown[]) => string[],
): void {
  const lists = mutations({ keepTypes: options.keepTypes ?? false });
  fc.assert(
    fc.property(lists, (list: Mutation[]) => {
      const { doc: mutated, applied } = mutateJson(doc, list, options);
      report(applied, check(mutated as Rec));
    }),
    fuzzParameters(options.runs),
  );
}

/** {@link fuzzJson} for an XML document, mutated with its well-formedness kept. */
export function fuzzXml(
  xml: string,
  options: XmlMutationOptions & { runs: number },
  check: (mutated: string) => string[],
): void {
  fc.assert(
    fc.property(mutations(), (list: Mutation[]) => {
      const { xml: mutated, applied } = mutateXml(xml, list, options);
      report(applied, check(mutated));
    }),
    fuzzParameters(options.runs),
  );
}

/** A JSON body. */
export const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

/** The distinct values `key` gives the records that have one. */
export function distinct<T>(records: readonly unknown[], key: (r: Rec) => T | undefined): number {
  const seen = new Set<string>();
  for (const r of records) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
    const k = key(r as Rec);
    if (k !== undefined) seen.add(JSON.stringify(k));
  }
  return seen.size;
}
