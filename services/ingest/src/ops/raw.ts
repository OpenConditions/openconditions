import postgres from "postgres";
import { loadIngestCatalog } from "../domains.js";
import { createOpenlrClient } from "../pipeline/run.js";
import { rawArchiveOptionsFromEnv } from "../raw/archive.js";
import { evictionPolicyFromEnv, evictRawPayloads } from "../raw/evict.js";
import { historyDaysFromEnv } from "../record-jobs.js";
import { replayRaw } from "./raw-replay.js";

const USAGE = `usage: raw pin <hash> [--fixture <name>] [--source <id>]
       raw unpin <hash> [--source <id>]
       raw gc [--dry-run]
       raw replay <source> --from <time> [--to <time>]`;

/** The value after `--flag` in `args`, if any. */
function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * The raw-payload archive's operator commands:
 *  - `pin <hash>` keeps a payload whatever eviction would do — a golden
 *    fixture (`--fixture <name>`) or a payload under dispute;
 *  - `unpin <hash>` hands it back to eviction;
 *  - `gc` runs eviction now; `--dry-run` only reports what it would evict;
 *  - `replay <source> --from <time>` re-parses the source's archived polls
 *    with the current parser and lists what reads differently from what each
 *    poll stored.
 * `--source` narrows a hash to one source (the same response from two
 * sources is two payloads). Returns the process exit code.
 */
export async function runRawCommand(
  sql: postgres.Sql,
  args: readonly string[],
  out: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<number> {
  const [command, hash] = args;
  if (
    (command === "pin" || command === "unpin") &&
    hash !== undefined &&
    /^[0-9a-f]{64}$/.test(hash)
  ) {
    const source = flag(args, "--source");
    const fixture = flag(args, "--fixture");
    const reason =
      command === "pin" ? (fixture !== undefined ? `fixture:${fixture}` : "manual") : null;
    const rows = await sql`
      UPDATE conditions.raw_payload SET pinned_reason = ${reason}
       WHERE hash = ${hash} AND (${source ?? null}::text IS NULL OR source_id = ${source ?? null})
       RETURNING source_id, evicted_at IS NOT NULL AS evicted`;
    if (rows.length === 0) {
      out(`no archived payload ${hash}${source ? ` of ${source}` : ""}`);
      return 1;
    }
    for (const r of rows) {
      out(
        `${command === "pin" ? "pinned" : "unpinned"} ${hash} of ${r["source_id"]}${r["evicted"] ? " (already evicted: its blob is gone)" : ""}`,
      );
    }
    return 0;
  }
  if (command === "gc") {
    const dryRun = args.includes("--dry-run");
    const result = await evictRawPayloads(sql, {
      dir: rawArchiveOptionsFromEnv(env).dir,
      policy: evictionPolicyFromEnv(now, env),
      historyDays: historyDaysFromEnv(env),
      dryRun,
    });
    const bySource = new Map<string, { payloads: number; bytes: number }>();
    for (const p of result.evict) {
      const s = bySource.get(p.sourceId) ?? { payloads: 0, bytes: 0 };
      s.payloads += 1;
      s.bytes += p.bytesStored;
      bySource.set(p.sourceId, s);
    }
    out(
      `${dryRun ? "would evict" : "evicted"} ${result.evict.length} payload(s); cap rung ${result.rung}`,
    );
    for (const [source, s] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
      out(`  ${source}: ${s.payloads} payload(s), ${s.bytes} bytes`);
    }
    if (result.hotEvicted.length > 0) out(`  hot window cut for: ${result.hotEvicted.join(", ")}`);
    if (!dryRun) out(`purged ${result.purged} index row(s) of long-evicted payloads`);
    return 0;
  }
  if (command === "replay" && hash !== undefined && !hash.startsWith("--")) {
    const from = flag(args, "--from");
    const to = flag(args, "--to");
    if (
      from === undefined ||
      Number.isNaN(Date.parse(from)) ||
      (to && Number.isNaN(Date.parse(to)))
    ) {
      out(USAGE);
      return 2;
    }
    const feed = (await loadIngestCatalog(env)).feeds.find((f) => f.id === hash);
    if (feed === undefined) {
      out(`no scheduled feed ${hash}`);
      return 1;
    }
    const report = await replayRaw(sql, {
      feed,
      from: new Date(from),
      ...(to ? { to: new Date(to) } : {}),
      dir: rawArchiveOptionsFromEnv(env).dir,
      openlrClient: createOpenlrClient(),
    });
    for (const p of report.polls) {
      if (p.unavailable.length > 0) {
        out(`poll ${p.attemptId} at ${p.attemptedAt}: ${p.unavailable.length} payload(s) evicted`);
        continue;
      }
      out(
        `poll ${p.attemptId} at ${p.attemptedAt}: ${p.same} same, ${p.changed.length} changed, ` +
          `${p.created.length} new, ${p.gone.length} gone` +
          (p.unplaced.length > 0 ? `, ${p.unplaced.length} unplaced` : ""),
      );
      for (const id of p.changed) out(`  changed ${id}`);
      for (const id of p.created) out(`  new ${id}`);
      for (const id of p.gone) out(`  gone ${id}`);
    }
    if (report.polls.length === 0) out(`no archived poll of ${hash} since ${from}`);
    return 0;
  }
  out(USAGE);
  return 2;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    process.exitCode = await runRawCommand(sql, process.argv.slice(2), (line) =>
      process.stdout.write(`${line}\n`),
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
