import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
import { roadFeedSchema } from "@openconditions/roads";
import { validateFeed, type FeedValidation } from "./lib/validate-feed.ts";

const FEED_FILE_RE = /(?:^|\/)feeds\/.+\.json5?$/;

/** True for a `feeds/<domain>/<region>.json5?` data file (not parser code or docs). */
export function isFeedFile(path: string): boolean {
  return FEED_FILE_RE.test(path);
}

/**
 * A feed is "keyless" when it needs no operator secret and can therefore be
 * fetched in public CI. Keyed feeds hit the same wall Transitous hits (a fork /
 * PR runner has no secrets) — we skip them with a note, same graceful answer.
 */
export function isKeyless(feed: FeedSourceBase): boolean {
  if ((feed.requiredEnv?.length ?? 0) > 0) return false;
  const auth = feed.auth;
  if (!auth || auth.kind === "none") return true;
  // A query-key auth with a published default value works with no env var set.
  if (auth.kind === "query-key" && auth.defaultValue) return true;
  return false;
}

export type GitRunner = (args: string[]) => string;

const defaultGit: GitRunner = (args) => execFileSync("git", args, { encoding: "utf8" });

/**
 * The changed feed data files between `baseRef` and HEAD. `--diff-filter=ACMRT`
 * drops deletions (a removed file has nothing to fetch). `git` is injectable so
 * the diff logic is unit-testable without a real repository.
 */
export function changedFeedFiles(baseRef: string, git: GitRunner = defaultGit): string[] {
  const out = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    `${baseRef}...HEAD`,
    "--",
    "packages/*/feeds/**",
  ]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isFeedFile(line));
}

export type FeedCheckStatus = "ok" | "skipped-keyed" | "parse-failure" | "upstream-flake";

export interface FeedCheckOutcome {
  feedId: string;
  file: string;
  status: FeedCheckStatus;
  rowCount?: number;
  detail?: string;
}

export interface ChangedFeedSummary {
  outcomes: FeedCheckOutcome[];
  ok: number;
  skipped: number;
  parseFailures: number;
  upstreamFlakes: number;
}

export interface CheckDeps {
  changedFiles: string[];
  load: (file: string) => Promise<FeedSourceBase[]>;
  validate: (feed: FeedSourceBase) => Promise<FeedValidation>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load each changed file, skip keyed feeds, run the shared liveness harness on
 * the keyless ones, and classify every outcome. Never throws — a failure to load
 * a file becomes a parse-failure outcome; a harness throw becomes an
 * upstream-flake outcome — so the caller can always finish and exit 0.
 */
export async function checkChangedFeeds(deps: CheckDeps): Promise<ChangedFeedSummary> {
  const outcomes: FeedCheckOutcome[] = [];

  for (const file of deps.changedFiles) {
    let feeds: FeedSourceBase[];
    try {
      feeds = await deps.load(file);
    } catch (err) {
      outcomes.push({
        feedId: "(file)",
        file,
        status: "parse-failure",
        detail: `could not load/parse ${file}: ${errText(err)}`,
      });
      continue;
    }

    for (const feed of feeds) {
      if (!isKeyless(feed)) {
        outcomes.push({
          feedId: feed.id,
          file,
          status: "skipped-keyed",
          detail: "needs operator credentials; not checkable in public CI",
        });
        continue;
      }

      let result: FeedValidation;
      try {
        result = await deps.validate(feed);
      } catch (err) {
        // an unexpected throw from the harness is treated as a transient flake
        outcomes.push({ feedId: feed.id, file, status: "upstream-flake", detail: errText(err) });
        continue;
      }

      if (result.ok) {
        outcomes.push({ feedId: feed.id, file, status: "ok", rowCount: result.rowCount });
      } else if (result.failureKind === "upstream") {
        outcomes.push({ feedId: feed.id, file, status: "upstream-flake", detail: result.message });
      } else {
        // "parse" (and any other/undefined kind) is contributor-fixable → surfaced as an error
        outcomes.push({ feedId: feed.id, file, status: "parse-failure", detail: result.message });
      }
    }
  }

  return {
    outcomes,
    ok: outcomes.filter((o) => o.status === "ok").length,
    skipped: outcomes.filter((o) => o.status === "skipped-keyed").length,
    parseFailures: outcomes.filter((o) => o.status === "parse-failure").length,
    upstreamFlakes: outcomes.filter((o) => o.status === "upstream-flake").length,
  };
}

/**
 * GitHub workflow annotations. `::error::` for a contributor-fixable parse
 * failure, `::warning::` for a transient upstream flake, `::notice::` for OK /
 * skipped. All are non-gating — the job exits 0 regardless; these only surface in
 * the PR's Checks tab and inline on the changed file.
 */
export function formatAnnotations(summary: ChangedFeedSummary): string[] {
  const lines: string[] = [];
  for (const o of summary.outcomes) {
    const loc = `file=${o.file}`;
    switch (o.status) {
      case "ok":
        lines.push(`::notice ${loc}::${o.feedId}: fetched + parsed OK (${o.rowCount ?? 0} rows)`);
        break;
      case "skipped-keyed":
        lines.push(`::notice ${loc}::${o.feedId}: skipped — ${o.detail ?? "keyed feed"}`);
        break;
      case "upstream-flake":
        lines.push(
          `::warning ${loc}::${o.feedId}: upstream fetch failed (likely a transient flake; ` +
            `this check is non-gating): ${o.detail ?? ""}`
        );
        break;
      case "parse-failure":
        lines.push(
          `::error ${loc}::${o.feedId}: fetched but did not parse into valid rows — this looks ` +
            `like a feed-definition problem, please check the URL/format: ${o.detail ?? ""}`
        );
        break;
    }
  }
  lines.push(
    `::notice::changed-feed liveness: ${summary.ok} ok, ${summary.skipped} skipped (keyed), ` +
      `${summary.parseFailures} parse-failure(s), ${summary.upstreamFlakes} upstream flake(s). ` +
      `This check is non-gating and never fails the PR.`
  );
  return lines;
}

/** Production loader for one changed file: read → JSON5 → domain schema. */
async function loadFeedFile(file: string): Promise<FeedSourceBase[]> {
  const text = await readFile(file, "utf8");
  const raw = JSON5.parse(text) as unknown;
  const rows = Array.isArray(raw) ? raw : ((raw as { feeds?: unknown[] })?.feeds ?? []);
  return roadFeedSchema.array().parse(rows);
}

async function main(): Promise<void> {
  try {
    const baseRef = process.env["FEED_CHECK_BASE_REF"] ?? "origin/main";
    const summary = await checkChangedFeeds({
      changedFiles: changedFeedFiles(baseRef),
      load: loadFeedFile,
      validate: (feed) => validateFeed(feed),
    });
    for (const line of formatAnnotations(summary)) console.log(line);
  } catch (err) {
    // Non-gating by design even when the setup itself throws (e.g. an
    // unresolvable base ref) — surface it as a warning, never fail the job.
    console.error(`::warning::changed-feed liveness check crashed: ${errText(err)}`);
  }
  // Non-gating by design: surface parse failures AND upstream flakes as
  // annotations, but never fail the job — a human decides. Always exit 0.
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
