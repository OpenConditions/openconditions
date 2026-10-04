import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CatalogFeed,
  cellsCovering,
  createFetchState,
  type Env,
  type FeedPayloads,
  type FetchFn,
  feedSecretValues,
  fetchEndpoint,
  guardedFetch,
  loadCatalog,
  makeAuthorizedFetch,
  missingCredentials,
  type ParseOutput,
  redactSecrets,
  redactUrl,
} from "@openconditions/ingest-framework";
import { parseXmlDocument } from "@openconditions/roads";
import { domainOf, formatOf, INGEST_DOMAINS } from "../services/ingest/src/domains.js";
import {
  type BodyStreamFactory,
  bodyStreamFrom,
} from "../services/ingest/src/pipeline/body-stream.js";
import { streamFeed } from "../services/ingest/src/pipeline/measured-data.js";
import { loadReference } from "../services/ingest/src/pipeline/reference.js";
import { digestOnlyTee } from "../services/ingest/src/raw/stream-tee.js";
import { FEEDS_DIR } from "./lib/catalog-paths.js";
import { type FeedFailure, renderReport } from "./lib/liveness-report.js";

/**
 * The live catalogue check: each feed of the given region files fetched and
 * parsed the way the ingest service polls it, reference data included. A
 * payload that does not parse, or does not decode as JSON or XML and yields no
 * records, is an `error` (the definition is wrong: URL, format, mapping); a
 * fetch that fails on the network or with an HTTP status, a reference table
 * that cannot be loaded, or a well-formed payload with no records (nothing to
 * report right now) is a `warning`. A feed whose credentials are not set
 * is skipped, so a runner without secrets checks the keyless feeds only. An
 * on-demand feed is fetched for one cell, the one holding its `onDemand.probe`.
 */

export interface FeedCheck {
  feed: CatalogFeed;
  feedId: string;
  level: "ok" | "skipped" | "warning" | "error";
  message?: string;
  /** Records the feed parsed into, when it was fetched. */
  records?: number;
}

export interface FeedsCheckOptions {
  feedsDir: string;
  /** Region files whose feeds are checked; every file when absent. */
  files?: readonly string[];
  /** Replaces the egress-guarded fetch (tests). */
  fetch?: FetchFn;
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordCount(output: ParseOutput): number {
  return (
    output.situations.length +
    output.features.length +
    output.observations.length +
    output.offers.length
  );
}

/**
 * Why a payload is not a well-formed JSON or XML document; undefined when it
 * is one, or is empty. A payload that is neither (an error text, a CSV that
 * yielded nothing) counts as undecodable.
 */
function undecodable(buffer: Buffer): string | undefined {
  const text = buffer.toString("utf8").replace(/^﻿/, "").trimStart();
  if (text === "") return undefined;
  const head = text[0];
  try {
    if (head === "{" || head === "[") JSON.parse(text);
    else if (head === "<") parseXmlDocument(text, { isArray: () => false });
    else return `payload is neither JSON nor XML (starts ${JSON.stringify(text.slice(0, 20))})`;
    return undefined;
  } catch (err) {
    return `payload does not decode: ${errorText(err)}`;
  }
}

/** The roles a feed's format parses itself; the others are reference data. */
function dataRoles(feed: CatalogFeed): string[] {
  return Object.entries(feed.endpoints)
    .filter(([, endpoint]) => endpoint.decoder === undefined)
    .map(([role]) => role);
}

async function checkFeed(feed: CatalogFeed, baseFetch: FetchFn, env: Env): Promise<FeedCheck> {
  const result = (level: FeedCheck["level"], message?: string, records?: number): FeedCheck => ({
    feed,
    feedId: feed.id,
    level,
    ...(message !== undefined ? { message } : {}),
    ...(records !== undefined ? { records } : {}),
  });

  if (feed.disabled) return result("skipped", `disabled: ${feed.disabled.reason}`);
  const missing = missingCredentials(feed, env);
  if (missing.length > 0) return result("skipped", `missing configuration: ${missing.join(", ")}`);

  let format: ReturnType<typeof formatOf>;
  try {
    format = formatOf(feed);
  } catch (err) {
    return result("error", errorText(err));
  }
  const secrets = feedSecretValues(feed, env);
  const redact = (s: string) => redactSecrets(redactUrl(s), secrets);
  const fetchFn = makeAuthorizedFetch(feed, baseFetch, env);
  const warnings: string[] = [];

  const reference: Record<string, unknown> = {};
  for (const [role, endpoint] of Object.entries(feed.endpoints)) {
    if (endpoint.decoder === undefined) continue;
    const data = await loadReference(feed, role, fetchFn, Date.now, digestOnlyTee, env);
    if (data !== undefined) reference[role] = data;
    else if (format.endpoints[role]?.required) {
      return result("warning", `${role} (${endpoint.decoder}) could not be loaded`);
    } else warnings.push(`${role} (${endpoint.decoder}) could not be loaded`);
  }
  const ctx = { fetchedAt: new Date().toISOString(), cadenceSec: feed.cadenceSec, reference };

  // A format too large to buffer is read as the service reads it, streamed.
  // A failure before the body opens is the network's; one while reading it,
  // the payload's.
  if (format.stream) {
    const open = bodyStreamFrom(fetchFn, redact);
    let opened = false;
    const tracked: BodyStreamFactory = async (url, init) => {
      opened = false;
      const body = await open(url, init);
      opened = true;
      return body;
    };
    try {
      const { output } = await streamFeed(feed, format.stream, tracked, ctx, digestOnlyTee, env);
      const records = recordCount(output);
      if (records === 0) warnings.push("parsed 0 records");
      return warnings.length > 0
        ? result("warning", warnings.join("; "), records)
        : result("ok", undefined, records);
    } catch (err) {
      return result(opened ? "error" : "warning", redact(errorText(err)));
    }
  }

  // An on-demand feed answers for a cell: the one holding its probe.
  const cell = feed.onDemand
    ? cellsCovering([...feed.onDemand.probe, ...feed.onDemand.probe], feed.onDemand.cellDeg)[0]
    : undefined;
  const payloads: Record<string, readonly Buffer[]> = {};
  for (const role of dataRoles(feed)) {
    try {
      const fetched = await fetchEndpoint(feed, role, fetchFn, {
        state: createFetchState(),
        resolvers: domainOf(feed).resolvers,
        env,
        ...(cell ? { cell } : {}),
      });
      if (fetched.status === "no-endpoint") {
        return result("skipped", `endpoint ${role} resolves to no URL (missing configuration)`);
      }
      if (fetched.status === "not-modified") continue;
      if (fetched.status === "partial") {
        const { failed, total } = fetched.partitions;
        warnings.push(`endpoint ${role}: ${failed} of ${total} URLs failed`);
      }
      payloads[role] = fetched.buffers;
    } catch (err) {
      return result("warning", redact(errorText(err)));
    }
  }

  let records: number;
  try {
    records = recordCount(format.parse(feed, payloads as FeedPayloads, ctx));
  } catch (err) {
    return result("error", redact(errorText(err)));
  }
  // The parsers drop a payload they cannot read rather than throw, so a feed
  // with no records is checked for whether its payloads decode at all: an
  // undecodable one is a broken definition, a well-formed empty one is a feed
  // with nothing to report right now.
  if (records === 0) {
    for (const buffers of Object.values(payloads)) {
      for (const buffer of buffers) {
        const why = undecodable(buffer);
        if (why) return result("error", `parsed 0 records: ${redact(why)}`, 0);
      }
    }
    warnings.push("parsed 0 records from a well-formed payload");
  }
  return warnings.length > 0
    ? result("warning", warnings.join("; "), records)
    : result("ok", undefined, records);
}

/** The region files of the catalogue in `feedsDir`, as absolute paths. */
function regionFiles(feedsDir: string): Set<string> {
  return new Set(
    INGEST_DOMAINS.flatMap((domain) => {
      const dir = path.resolve(feedsDir, domain.id);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonc") && !name.startsWith("."))
        .map((name) => path.join(dir, name));
    }),
  );
}

/**
 * Loads the catalogue in `feedsDir` as the service would (throwing on a schema
 * or lint error) and checks each scheduled or disabled feed written in one of
 * `files`, in catalogue order. Catalogue children are checked under their
 * parent's file. Throws, naming them, on `files` that are no region file of
 * the catalogue, so a typo is not a silent pass.
 */
export async function checkFeeds(opts: FeedsCheckOptions): Promise<FeedCheck[]> {
  const env = opts.env ?? process.env;
  const known = regionFiles(opts.feedsDir);
  const stray = (opts.files ?? []).filter((f) => !known.has(path.resolve(f)));
  if (stray.length > 0) {
    throw new Error(`not a region file of ${opts.feedsDir}: ${stray.join(", ")}`);
  }
  const catalog = await loadCatalog(INGEST_DOMAINS, { baked: opts.feedsDir });
  const wanted = opts.files ? new Set(opts.files.map((f) => path.resolve(f))) : undefined;
  const feeds = [...catalog.feeds, ...catalog.disabled].filter(
    (feed) => !wanted || wanted.has(path.resolve(feed.file)),
  );
  const baseFetch = opts.fetch ?? guardedFetch();
  const results: FeedCheck[] = [];
  for (const feed of feeds) results.push(await checkFeed(feed, baseFetch, env));
  return results;
}

/** One result as a line, or as a GitHub annotation on the region file. */
function formatResult(r: FeedCheck, annotate: boolean): string {
  const detail = r.message ?? `${r.records ?? 0} records`;
  if (annotate && (r.level === "error" || r.level === "warning")) {
    const file = path.relative(process.cwd(), r.feed.file);
    return `::${r.level} file=${file}::${r.feedId}: ${detail}`;
  }
  return `${r.level.padEnd(8)} ${r.feedId}: ${detail}`;
}

/**
 * `feeds:check [files…] [--report <path>]`: checks the feeds of the given
 * region files (every file when none is given) and returns the exit code, 1 on
 * a catalogue, parse or format error or a file that is no region file, 2 on a
 * usage error. `--report` writes the liveness report of the failing feeds and,
 * on GitHub Actions, sets the `found` step output.
 */
export async function runFeedsCheck(
  argv: readonly string[],
  deps: Partial<FeedsCheckOptions> = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const files: string[] = [];
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--report") {
      files.push(argv[i] as string);
      continue;
    }
    report = argv[++i];
    if (report === undefined || report.startsWith("--")) {
      console.error("usage: feeds:check [files…] [--report <path>]");
      return 2;
    }
  }

  let results: FeedCheck[];
  try {
    results = await checkFeeds({
      feedsDir: deps.feedsDir ?? FEEDS_DIR,
      ...(files.length > 0 ? { files } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      env,
    });
  } catch (err) {
    console.error(`error    ${errorText(err)}`);
    return 1;
  }

  const annotate = env["GITHUB_ACTIONS"] === "true";
  for (const r of results) console.log(formatResult(r, annotate));
  const count = (level: FeedCheck["level"]) => results.filter((r) => r.level === level).length;
  console.log(
    `feeds:check: ${count("ok")} ok, ${count("warning")} warning(s), ${count("error")} error(s), ${count("skipped")} skipped`,
  );

  const failures: FeedFailure[] = results.flatMap((r) =>
    r.level === "error" || r.level === "warning"
      ? [{ feed: r.feed, level: r.level, ...(r.message ? { message: r.message } : {}) }]
      : [],
  );
  if (report !== undefined && failures.length > 0) {
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, renderReport(failures), "utf8");
    console.log(`feeds:check: wrote the report of ${failures.length} failing feed(s) to ${report}`);
    const output = env["GITHUB_OUTPUT"];
    if (output) await appendFile(output, "found=true\n");
  }
  return count("error") > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFeedsCheck(process.argv.slice(2));
}
