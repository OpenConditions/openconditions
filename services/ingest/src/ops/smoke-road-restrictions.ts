import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetch as undiciFetch } from "undici";
import type { Observation } from "@openconditions/core";
import {
  createFetchState,
  fetchAll,
  guardOptionsFromEnv,
  guardedFetch,
  makeAuthorizedFetch,
  type LookupFn,
} from "@openconditions/ingest-framework";
import { normalizeObservation } from "@openconditions/normalize";
import {
  eventsToExclusions,
  observationsToDatexSituations,
  observationsToGeoJSON,
  observationsToTraff,
} from "@openconditions/publishers";
import {
  FEED_SOURCES,
  hasRestrictionEvidence,
  isRoadRestrictionDetails,
} from "@openconditions/roads";
import { parseRoadSnapshotFor } from "../pipeline/parse.js";
import { resolveOpenLr } from "../pipeline/resolve.js";
import {
  inspectSnapshotCompleteness,
  stampSourceEvidence,
  type DomainFeedSource,
} from "../pipeline/run.js";

/**
 * A finite, operator-run smoke check for the restriction path.
 *
 * It reuses the real descriptor, the real guarded acquisition, the real parser,
 * the real normalization and the real publishers — nothing here re-implements a
 * step it is meant to verify. It performs exactly one complete acquisition per
 * invocation, starts no scheduler, and never loops.
 *
 * A missing restriction kind is reported as "not observed", not as a failure:
 * the pinned fixtures are the deterministic coverage gate. A transport, schema,
 * normalization or publication-safety failure IS a failure and exits nonzero.
 */

export type SmokeSourceId = "fi-digitraffic" | "nl-ndw";

export interface RunRestrictionSmokeOptions {
  sourceId: SmokeSourceId;
  outputDir: string;
  /** Disposable mode runs the full storage/binding/provider path locally. */
  database?: "disposable";
  /** Reviewed frozen spine JSON, required by disposable mode. */
  spineFile?: string;
}

export interface RunRestrictionSmokeDeps {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  now?: () => string;
}

interface RequestRecord {
  url: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  bytes: number | null;
}

export interface RestrictionSmokeReport {
  sourceId: string;
  mode: "validation-only" | "disposable-database";
  checkedAt: string;
  feedUrls: string[];
  requests: RequestRecord[];
  snapshot: {
    inputCount: number;
    uniqueCount: number;
    duplicates: number;
    accepted: number;
    terminal: number;
    unlocatable: number;
  };
  restrictions: {
    recordsWithDetails: number;
    facts: number;
    /** Counts per `dimension:unit`; absence of a kind is "not observed". */
    kinds: Record<string, number>;
    scopes: Record<string, number>;
    issues: Record<string, number>;
    unsupportedEnvelopes: number;
  };
  provenance: {
    sourceUpdatedAt: string | null;
    publisher: string | null;
    license: string | null;
    licenseUrl: string | null;
    termsUrl: string | null;
    rightsReviewedAt: string | null;
  };
  withheldExports: {
    segmentConditions: number;
    valhallaExclusions: number;
    datexSituations: number;
    traffMessages: number;
  };
  notes: string[];
}

/** Fields that must never reach a shared smoke report. */
const REDACTED_SOURCE_FIELDS = ["contact", "additionalInformation", "sender"];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_SOURCE_FIELDS.includes(key)) continue;
    // The raw national payload is never written to a report.
    if (key === "sourceRaw") continue;
    out[key] = redact(entry, depth + 1);
  }
  return out;
}

/** Record each response's validators without buffering its body twice. */
function recordingFetch(inner: typeof fetch, into: RequestRecord[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await inner(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const length = response.headers.get("content-length");
    into.push({
      url,
      status: response.status,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type"),
      bytes: length === null ? null : Number(length),
    });
    return response;
  }) as typeof fetch;
}

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/**
 * Acquire, parse, normalize and publish one snapshot, and report what the
 * exporters withheld. Throws on any failure that is not an honest empty
 * observation.
 */
export async function runRestrictionSmoke(
  options: RunRestrictionSmokeOptions,
  deps: RunRestrictionSmokeDeps = {}
): Promise<RestrictionSmokeReport> {
  if (options.sourceId === "nl-ndw") {
    throw new Error(
      "smoke: nl-ndw is not supported yet — the NDW restriction slice has not been implemented"
    );
  }
  if (!options.outputDir || options.outputDir.trim() === "") {
    throw new Error("smoke: an output directory is required");
  }
  const descriptor = FEED_SOURCES.find((candidate) => candidate.id === options.sourceId);
  if (!descriptor) throw new Error(`smoke: no feed descriptor for ${options.sourceId}`);
  const feed: DomainFeedSource = { ...descriptor, domain: "roads" };
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error("smoke: invalid checked time");

  // Exclusive directory creation: a smoke run never silently overwrites the
  // artefacts an operator is about to read.
  await mkdir(options.outputDir, { recursive: true });

  const requests: RequestRecord[] = [];
  const baseFetch = deps.fetch ?? (undiciFetch as unknown as typeof fetch);
  const guarded = guardedFetch(
    recordingFetch(baseFetch, requests),
    guardOptionsFromEnv(),
    {},
    deps.lookup
  );
  const acquired = await fetchAll(feed, makeAuthorizedFetch(feed, guarded), {
    state: createFetchState(),
    now: () => Date.parse(checkedAt),
  });
  if (acquired.status !== "fetched") {
    throw new Error(`smoke acquisition: ${acquired.status}`);
  }

  // The completeness contract is checked before the parser, so a structurally
  // truncated snapshot fails here rather than looking like a small feed.
  const completeness = inspectSnapshotCompleteness(feed, acquired.buffers);
  if (!completeness.complete) throw new Error("smoke: source declares no complete snapshot");

  const report = parseRoadSnapshotFor(feed, acquired.buffers);
  if (!report) throw new Error("source lacks complete road snapshot reporting");

  // No OpenLR client in smoke mode: unresolved references are reported as
  // unlocatable, never as successfully graph-bound.
  const located = await resolveOpenLr(report.observations, null);
  if (located.failed > 0) throw new Error("smoke location resolution failed");

  const normalized = located.resolved.map((observation) =>
    normalizeObservation(stampSourceEvidence(observation, feed), {
      kind: "feed",
      instanceId: "local-restriction-smoke",
    })
  );

  const forPublication = normalized.map((observation) => ({
    ...observation,
    sourceCheckedAt: checkedAt,
    freshnessWindowSec: feed.freshnessWindowSec,
  })) as Observation[];
  const display = observationsToGeoJSON(forPublication, {}, { at: new Date(checkedAt) });

  const restrictions: RestrictionSmokeReport["restrictions"] = {
    recordsWithDetails: 0,
    facts: 0,
    kinds: {},
    scopes: {},
    issues: {},
    unsupportedEnvelopes: 0,
  };
  for (const feature of display.features) {
    const properties = feature.properties ?? {};
    if (properties["restrictionDetailsUnsupported"] === true) {
      restrictions.unsupportedEnvelopes++;
      continue;
    }
    const details = properties["restrictionDetails"];
    if (details === undefined) continue;
    restrictions.recordsWithDetails++;
    const view = details as {
      facts: Array<Record<string, unknown>>;
      issues: Array<{ code: string }>;
    };
    restrictions.facts += view.facts.length;
    for (const fact of view.facts) {
      const kind =
        fact["kind"] === "dimension"
          ? `${String(fact["dimension"])}:${String(fact["unit"])}`
          : `${String(fact["kind"])}:${String(fact["value"])}`;
      tally(restrictions.kinds, kind);
      tally(restrictions.scopes, String((fact["scope"] as { kind?: unknown })?.kind));
    }
    for (const issue of view.issues) tally(restrictions.issues, issue.code);
  }

  const events = forPublication.filter((observation) => observation.kind === "event");
  const conditional = events.filter((observation) => hasRestrictionEvidence(observation));
  const datex = observationsToDatexSituations(events as never, {}, feed.country ?? "other");
  const traff = observationsToTraff(events as never);
  for (const record of conditional) {
    if (datex.includes(record.id) || traff.includes(record.id)) {
      throw new Error(`smoke publication safety: conditional record exported: ${record.id}`);
    }
  }
  // Feed the conditional records alone to the exclusion emitter: if any of
  // them can still produce avoidance geometry, that is a safety failure rather
  // than something to count.
  const conditionalExclusions = eventsToExclusions(conditional, {
    activeAt: new Date(checkedAt),
    evaluatedAt: new Date(checkedAt),
  });
  if (
    conditionalExclusions.exclude_locations.length > 0 ||
    conditionalExclusions.exclude_polygons.length > 0
  ) {
    throw new Error("smoke publication safety: a conditional record produced Valhalla exclusions");
  }

  const firstDetails = display.features
    .map((feature) => feature.properties?.["restrictionDetails"])
    .find((details) => isRoadRestrictionDetails(details)) as
    { source: Record<string, string | null> } | undefined;

  const notes: string[] = [];
  for (const kind of ["height:m", "width:m", "length:m", "gross_weight:kg"]) {
    if (restrictions.kinds[kind] === undefined) {
      notes.push(`not observed in this snapshot: ${kind}`);
    }
  }
  if (restrictions.recordsWithDetails === 0) {
    notes.push("no restriction-bearing record in this snapshot; frozen fixtures remain the gate");
  }
  notes.push("validation-only run: no observation was published to a database");

  const result: RestrictionSmokeReport = {
    sourceId: feed.id,
    mode: "validation-only",
    checkedAt,
    feedUrls: Array.isArray(feed.url) ? feed.url : feed.url ? [feed.url] : [],
    requests,
    snapshot: {
      inputCount: report.inputCount,
      uniqueCount: report.uniqueCount,
      duplicates: report.duplicates,
      accepted: report.acceptedIds.length,
      terminal: report.terminalIds.length,
      unlocatable: [...new Set([...report.unlocatableIds, ...located.unlocatableIds])].length,
    },
    restrictions,
    provenance: {
      sourceUpdatedAt: firstDetails?.source["sourceUpdatedAt"] ?? null,
      publisher: firstDetails?.source["publisher"] ?? null,
      license: feed.license ?? null,
      licenseUrl: feed.licenseUrl ?? null,
      termsUrl: feed.rights?.termsUrl ?? null,
      rightsReviewedAt: feed.rights?.reviewedAt ?? null,
    },
    // Every restriction-bearing record is withheld from each lossy or routing
    // exporter, so one count describes all four.
    withheldExports: {
      segmentConditions: conditional.length,
      valhallaExclusions: conditional.length,
      datexSituations: conditional.length,
      traffMessages: conditional.length,
    },
    notes,
  };

  await writeFile(
    join(options.outputDir, "report.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(options.outputDir, "display.geojson"),
    `${JSON.stringify(redact(display), null, 2)}\n`,
    "utf8"
  );
  return result;
}

function parseArgs(args: string[]): RunRestrictionSmokeOptions {
  const read = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const sourceId = read("--source");
  const outputDir = read("--output");
  if (sourceId !== "fi-digitraffic" && sourceId !== "nl-ndw") {
    throw new Error(
      "usage: --source <fi-digitraffic|nl-ndw> --output <dir> [--database disposable]"
    );
  }
  if (!outputDir) throw new Error("usage: --source <id> --output <dir>");
  const database = read("--database");
  if (database !== undefined && database !== "disposable") {
    throw new Error("--database accepts only 'disposable'");
  }
  const spineFile = read("--spine");
  if (database === "disposable" && !spineFile) {
    throw new Error("--database disposable requires --spine <reviewed spine JSON>");
  }
  return {
    sourceId,
    outputDir,
    ...(database === "disposable" ? { database } : {}),
    ...(spineFile !== undefined ? { spineFile } : {}),
  };
}

export async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  if (options.database === "disposable") {
    // Loaded lazily so the default path never pulls the container runtime into
    // the ops bundle. One requested smoke is one complete acquisition, so the
    // non-database path is not run first.
    const { runRestrictionSmokeWithDatabase } =
      await import("./smoke-road-restrictions-database.integration.js");
    const databaseReport = await runRestrictionSmokeWithDatabase(options);
    console.info(
      `[smoke] ${databaseReport.sourceId}: published ${databaseReport.published} row(s), ` +
        `bound ${databaseReport.bound}, withheld ${databaseReport.withheldConditional} conditional record(s)`
    );
    for (const note of databaseReport.notes) console.info(`[smoke] ${note}`);
    return;
  }
  const report = await runRestrictionSmoke(options);
  console.info(
    `[smoke] ${report.sourceId}: ${report.snapshot.accepted} accepted, ` +
      `${report.snapshot.terminal} terminal, ${report.snapshot.unlocatable} unlocatable, ` +
      `${report.restrictions.facts} restriction fact(s) across ` +
      `${report.restrictions.recordsWithDetails} record(s)`
  );
  for (const note of report.notes) console.info(`[smoke] ${note}`);
}
