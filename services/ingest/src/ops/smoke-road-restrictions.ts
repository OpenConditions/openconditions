import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createFetchState,
  fetchAll,
  guardedFetch,
  guardOptionsFromEnv,
  type LookupFn,
  makeAuthorizedFetch,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { isVehicleSpecific, situationEffects } from "@openconditions/model";
import { FEED_SOURCES } from "@openconditions/roads";
import { fetch as undiciFetch } from "undici";
import { parseEventFeed } from "../pipeline/parse.js";
import { stampAttribution, writeModel } from "../pipeline/publish.js";
import { resolveOpenLr } from "../pipeline/resolve.js";
import { type RestrictionTally, tallyRestrictions } from "../pipeline/restriction-tally.js";
import { type DomainFeedSource, inspectSnapshotCompleteness } from "../pipeline/run.js";

/**
 * A finite, operator-run smoke check for the restriction path.
 *
 * It reuses the real descriptor, the real guarded acquisition, the real parser
 * and the real registry validation — nothing here re-implements a step it is
 * meant to verify. It performs exactly one complete acquisition per
 * invocation, starts no scheduler, and never loops.
 *
 * A missing restriction kind is reported as "not observed", not as a failure:
 * the pinned fixtures are the deterministic coverage gate. A transport,
 * schema or validation failure IS a failure and exits nonzero.
 */

export type SmokeSourceId = "fi-digitraffic" | "nl-ndw";

export interface RunRestrictionSmokeOptions {
  sourceId: SmokeSourceId;
  outputDir: string;
  /** Disposable mode runs the full storage/binding path locally. */
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
  /** The descriptor's declared parser format, so a silent format swap is visible. */
  sourceFormat: string;
  mode: "validation-only" | "disposable-database";
  checkedAt: string;
  /** The source's own freshness window, never a shared default. */
  freshnessWindowSec: number | null;
  feedUrls: string[];
  requests: RequestRecord[];
  snapshot: {
    inputCount: number;
    uniqueCount: number;
    duplicates: number;
    accepted: number;
    terminal: number;
    unlocatable: number;
    situations: number;
  };
  restrictions: RestrictionTally;
  provenance: {
    sourceUpdatedAt: string | null;
    recordId: string | null;
    recordVersion: string | null;
    publisher: string | null;
    license: string | null;
    licenseUrl: string | null;
    termsUrl: string | null;
    rightsReviewedAt: string | null;
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
    out[key] = redact(entry, depth + 1);
  }
  return out;
}

/** The situations as a GeoJSON FeatureCollection, for an operator to look at. */
function displayOf(situations: readonly RecordDraft[]) {
  return {
    type: "FeatureCollection",
    features: situations.map((situation) => {
      const location = situation["location"] as { geometry?: unknown } | undefined;
      return {
        type: "Feature",
        id: situation["id"],
        geometry: location?.geometry ?? null,
        properties: redact(situation),
      };
    }),
  };
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

/**
 * Acquire and parse one snapshot, validate every situation against the
 * registry, and report what its vehicle-specific effects say. Throws on any
 * failure that is not an honest empty observation.
 */
export async function runRestrictionSmoke(
  options: RunRestrictionSmokeOptions,
  deps: RunRestrictionSmokeDeps = {},
): Promise<RestrictionSmokeReport> {
  // Sources whose restriction normalization has been verified against a
  // reviewed capture. Anything else would produce a report whose numbers nobody
  // has checked, so it is refused rather than run.
  const allowed = new Set(["fi-digitraffic", "nl-ndw"]);
  if (!allowed.has(options.sourceId)) {
    throw new Error(`smoke: unsupported restriction smoke source ${options.sourceId}`);
  }
  if (!options.outputDir || options.outputDir.trim() === "") {
    throw new Error("smoke: an output directory is required");
  }
  const descriptor = FEED_SOURCES.find((candidate) => candidate.id === options.sourceId);
  if (!descriptor) throw new Error(`smoke: restriction smoke source not configured`);
  const feed: DomainFeedSource = { ...descriptor, domain: "roads" };
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error("smoke: invalid checked time");

  await mkdir(options.outputDir, { recursive: true });

  const requests: RequestRecord[] = [];
  const baseFetch = deps.fetch ?? (undiciFetch as unknown as typeof fetch);
  const guarded = guardedFetch(
    recordingFetch(baseFetch, requests),
    guardOptionsFromEnv(),
    {},
    deps.lookup,
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

  const parsed = parseEventFeed(feed, acquired.buffers);
  const accounting = parsed.records;
  if (!accounting) throw new Error("source lacks complete road snapshot reporting");

  // No OpenLR client in smoke mode: unresolved references are reported as
  // unlocatable, never as successfully placed.
  const located = await resolveOpenLr(parsed.situations, null);
  if (located.failed > 0) throw new Error("smoke location resolution failed");
  const situations = located.resolved.map((draft) => stampAttribution(draft, feed));

  const { registry } = writeModel();
  for (const situation of situations) {
    const checked = registry.validateDraft(situation);
    if (!checked.ok) {
      const issue = checked.issues[0]!;
      throw new Error(
        `smoke validation: ${String(situation["id"])}: ${issue.path.join(".")}: ${issue.message}`,
      );
    }
  }

  const restrictions = tallyRestrictions(situations);
  const first = situations.find((s) => situationEffects(s).some(isVehicleSpecific));
  const provenance = first?.["provenance"] as Record<string, unknown> | undefined;
  const notes: string[] = [];
  for (const kind of ["height:m", "width:m", "length:m", "gross_weight:kg"]) {
    if (restrictions.kinds[kind] === undefined)
      notes.push(`not observed in this snapshot: ${kind}`);
  }
  if (restrictions.situations === 0) {
    notes.push(
      "no restriction-bearing situation in this snapshot; frozen fixtures remain the gate",
    );
  }
  notes.push("validation-only run: nothing was written to a database");

  const result: RestrictionSmokeReport = {
    sourceId: feed.id,
    sourceFormat: feed.format,
    mode: "validation-only",
    checkedAt,
    freshnessWindowSec: feed.freshnessWindowSec ?? null,
    feedUrls: Array.isArray(feed.url) ? feed.url : feed.url ? [feed.url] : [],
    requests,
    snapshot: {
      inputCount: accounting.inputCount,
      uniqueCount: accounting.uniqueCount,
      duplicates: accounting.duplicates,
      accepted: accounting.accepted,
      terminal: accounting.terminal,
      unlocatable: accounting.unlocatable + located.unlocatable.length,
      situations: situations.length,
    },
    restrictions,
    provenance: {
      sourceUpdatedAt: (provenance?.["sourceUpdatedAt"] as string | undefined) ?? null,
      recordId: (provenance?.["recordId"] as string | undefined) ?? null,
      recordVersion: (provenance?.["recordVersion"] as string | undefined) ?? null,
      publisher: feed.attribution ?? null,
      license: feed.license ?? null,
      licenseUrl: feed.licenseUrl ?? null,
      termsUrl: feed.rights?.termsUrl ?? null,
      rightsReviewedAt: feed.rights?.reviewedAt ?? null,
    },
    notes,
  };

  await writeFile(
    join(options.outputDir, "report.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(options.outputDir, "display.geojson"),
    `${JSON.stringify(displayOf(situations), null, 2)}\n`,
    "utf8",
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
      "usage: --source <fi-digitraffic|nl-ndw> --output <dir> [--database disposable]",
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
    const { runRestrictionSmokeWithDatabase } = await import(
      "./smoke-road-restrictions-database.integration.js"
    );
    const databaseReport = await runRestrictionSmokeWithDatabase(options);
    console.info(
      `[smoke] ${databaseReport.sourceId}: published ${databaseReport.published} situation(s), ` +
        `bound ${databaseReport.bound}, ${databaseReport.restrictions.evidence} ` +
        `restriction-evidence effect(s) withheld from routing`,
    );
    for (const note of databaseReport.notes) console.info(`[smoke] ${note}`);
    return;
  }
  const report = await runRestrictionSmoke(options);
  console.info(
    `[smoke] ${report.sourceId}: ${report.snapshot.accepted} accepted, ` +
      `${report.snapshot.terminal} terminal, ${report.snapshot.unlocatable} unlocatable, ` +
      `${report.restrictions.effects} restriction effect(s) across ` +
      `${report.restrictions.situations} situation(s)`,
  );
  for (const note of report.notes) console.info(`[smoke] ${note}`);
}
