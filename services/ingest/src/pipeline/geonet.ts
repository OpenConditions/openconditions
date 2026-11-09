import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  GEONET_ACCEPT,
  GEONET_COVERAGE_MS,
  type GeonetSolution,
  geonetAddSolution,
  geonetDraft,
  geonetFeatures,
  geonetRevision,
  geonetSolutions,
} from "@openconditions/hazards";
import type { CatalogFeed, FeedPayloads, RecordDraft } from "@openconditions/ingest-framework";
import { tombstoneRecords, writeSnapshotIn } from "@openconditions/storage";
import type postgres from "postgres";
import type { RawArchive } from "../raw/archive.js";
import { rawTierFor } from "../raw/tiers.js";
import type { ParseProcess } from "./parse-process.js";
import { stampAttribution, type WriteModel } from "./publish.js";
import { openPollAttempt, upsertSourceStatus } from "./source-status.js";

type Rec = Record<string, unknown>;
const properties = (f: Rec) => f["properties"] as Rec;
export const GEONET_MAX_EVENTS = 512;
type RevisionState = Record<string, { feature?: Rec; solution?: GeonetSolution }>;
export interface GeonetAcquisition {
  revisions: RevisionState;
  payloads: FeedPayloads;
  drafts: RecordDraft[];
  terminal: string[];
  hashes: string[];
  coveredFrom: string;
  coveredUntil: string;
}

/** A bounded poll has no conditional cache: every partition must answer anew. 204 says nothing about deletion. */
export async function acquireGeonet(
  feed: CatalogFeed,
  fetchFn: typeof fetch,
  at: string,
  retained: readonly string[],
  since?: string,
  signal?: AbortSignal,
  capture?: (url: string, body: Buffer) => Promise<void>,
  previous: RevisionState = {},
): Promise<GeonetAcquisition> {
  const deadline = AbortSignal.timeout(300_000);
  const abort = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let requests = 0;
  let bytes = 0;
  const hashes: string[] = [];
  const payloads: Record<string, Buffer[]> = { solutions: [], detail: [], selected: [] };
  const request = async (
    url: string,
    accept: string,
  ): Promise<{ status: number; body: Buffer }> => {
    for (let attempt = 0; ; attempt++) {
      abort.throwIfAborted();
      if (++requests > 1800) throw new Error("GeoNet request budget exhausted");
      const res = await fetchFn(url, {
        headers: { Accept: accept, "Accept-Encoding": "gzip" },
        signal: abort,
      });
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
        await res.body?.cancel();
        await delay(250 * 2 ** attempt, undefined, { signal: abort });
        continue;
      }
      if (res.status === 204 || res.status === 413) {
        await res.body?.cancel();
        return { status: res.status, body: Buffer.alloc(0) };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GeoNet HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("GeoNet missing body");
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          abort.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          bytes += value.byteLength;
          if (size > 8_000_000 || bytes > 32_000_000)
            throw new Error("GeoNet byte budget exhausted");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const body = Buffer.concat(chunks);
      await capture?.(url, body);
      hashes.push(createHash("sha256").update(body).digest("hex"));
      return { status: res.status, body };
    }
  };
  const from = Date.parse(at) - GEONET_COVERAGE_MS;
  const until = Date.parse(at);
  if (!Number.isFinite(from)) throw new Error("Invalid GeoNet acquisition time");
  const ids = new Set(retained);
  const add = (id: string) => {
    ids.add(id);
    if (ids.size > GEONET_MAX_EVENTS) throw new Error("GeoNet event budget exhausted");
  };
  const recent = await request("https://api.geonet.org.nz/quake?MMI=-1", GEONET_ACCEPT);
  if (recent.status !== 200) throw new Error("GeoNet discovery did not answer");
  for (const f of geonetFeatures(recent.body)) add(String(properties(f)["publicID"]));
  const revisions: RevisionState = {};
  const solutions = new Map<string, GeonetSolution>();
  const candidates = new Map<string, GeonetSolution[]>();
  for (const [id, prior] of Object.entries(previous)) {
    const origin = prior.solution?.time ?? properties(prior.feature ?? {})?.["time"];
    if (
      retained.includes(id) ||
      (origin && Date.parse(String(origin)) + GEONET_COVERAGE_MS > until)
    ) {
      add(id);
      revisions[id] = prior;
      if (prior.solution) solutions.set(id, geonetAddSolution(candidates, prior.solution, at));
    }
  }
  let partitions = 0;
  const window = async (start: number, end: number, updated?: string): Promise<void> => {
    if (++partitions > 64) throw new Error("GeoNet partition budget exhausted");
    const url = new URL("https://service.geonet.org.nz/fdsnws/event/1/query");
    url.searchParams.set("starttime", new Date(start).toISOString());
    url.searchParams.set("endtime", new Date(end).toISOString());
    url.searchParams.set("format", "xml");
    if (updated) url.searchParams.set("updatedafter", updated);
    // Include non-earthquake types so a reclassified event is not hidden.
    const res = await request(url.href, "application/xml");
    if (res.status === 413) {
      if (end - start <= 60_000)
        throw new Error("GeoNet minimum partition still exceeds service cap");
      const middle = Math.floor((start + end) / 2);
      await window(start, middle, updated);
      await window(middle - 1000, end, updated);
    } else if (res.status === 200) {
      payloads["solutions"]!.push(res.body);
      for (const s of geonetSolutions(res.body)) {
        add(s.id);
        solutions.set(s.id, geonetAddSolution(candidates, s, at));
      }
    } else if (res.status !== 204) throw new Error("GeoNet incomplete partition");
  };
  // Fully rescan the bounded coverage after restarts; the change query is supplementary.
  for (let start = from; start < until; start += 24 * 3600_000)
    await window(start - 60_000, Math.min(until, start + 24 * 3600_000));
  if (since) await window(from - 60_000, until, new Date(Date.parse(since) - 60_000).toISOString());
  const drafts: RecordDraft[] = [];
  const terminal: string[] = [];
  for (const id of [...ids].sort()) {
    abort.throwIfAborted();
    const detail = await request(`https://api.geonet.org.nz/quake/${id}`, GEONET_ACCEPT);
    if (detail.status === 204) {
      const solution = solutions.get(id);
      if (solution) revisions[id] = { ...revisions[id], solution };
      if (solutions.get(id)?.type && solutions.get(id)?.type !== "earthquake") terminal.push(id);
      continue;
    }
    if (detail.status !== 200) throw new Error("GeoNet detail incomplete");
    const features = geonetFeatures(detail.body);
    if (features.length === 0) continue;
    if (features.length !== 1 || properties(features[0]!)["publicID"] !== id)
      throw new Error("GeoNet detail identity mismatch");
    const history = await request(`https://api.geonet.org.nz/quake/history/${id}`, GEONET_ACCEPT);
    if (![200, 204].includes(history.status)) throw new Error("GeoNet history incomplete");
    const historyRevisions = history.status === 204 ? [] : geonetFeatures(history.body);
    if (historyRevisions.some((f) => properties(f)["publicID"] !== id))
      throw new Error("GeoNet history identity mismatch");
    const prior = previous[id]?.feature;
    const current = geonetRevision(
      features[0]!,
      [...historyRevisions, ...(prior ? [prior] : [])],
      at,
    );
    const currentClock = properties(features[0]!)["modificationTime"];
    const priorClock = prior && properties(prior)["modificationTime"];
    if (
      currentClock &&
      priorClock &&
      String(currentClock) !== String(priorClock) &&
      Date.parse(String(currentClock)) < Date.parse(String(priorClock))
    )
      throw new Error("Stale GeoNet durable revision");
    let solution = solutions.get(id);
    // Exact-id enrichment also catches revisions whose origin crossed the window boundary.
    if (properties(current)["quality"] !== "deleted") {
      const xml = await request(
        `https://service.geonet.org.nz/fdsnws/event/1/query?eventid=${id}`,
        "application/xml",
      );
      if (xml.status === 200) {
        payloads["solutions"]!.push(xml.body);
        const selected = geonetSolutions(xml.body);
        if (selected.length !== 1 || selected[0]!.id !== id)
          throw new Error("GeoNet exact-event mismatch");
        solution = geonetAddSolution(candidates, selected[0]!, at);
      } else if (xml.status !== 204) throw new Error("GeoNet exact-event incomplete");
    }
    revisions[id] = { feature: current, solution };
    payloads["detail"]!.push(
      Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [current] })),
    );
    if (solution) payloads["selected"]!.push(Buffer.from(JSON.stringify(solution)));
    const draft = geonetDraft(feed, current, solution, at);
    if (!draft) terminal.push(id);
    else if (
      retained.includes(id) ||
      Date.parse(String((draft["freshness"] as Rec)["expiresAt"])) > until
    )
      drafts.push(draft);
  }
  return {
    revisions,
    payloads,
    drafts,
    terminal,
    hashes,
    coveredFrom: new Date(from).toISOString(),
    coveredUntil: at,
  };
}

/** Publication and durable coverage state commit together. Failed acquisition never moves the cursor. */
export async function runGeonet(
  src: CatalogFeed,
  deps: {
    sql: postgres.Sql;
    fetch: typeof fetch;
    now: () => string;
    model: WriteModel;
    signal?: AbortSignal;
    raw?: RawArchive;
    parseProcess?: ParseProcess;
  },
): Promise<{ count: number; durationMs: number; error?: string }> {
  const started = Date.now();
  const at = deps.now();
  const attempt = await openPollAttempt(deps.sql, src.id, at);
  try {
    const [prior] = await deps.sql<
      { covered_until: string; revisions: RevisionState }[]
    >`SELECT covered_until::text, revisions FROM conditions.geonet_coverage WHERE source_id = ${src.id}`;
    if (prior && Date.parse(at) <= Date.parse(prior.covered_until))
      throw new Error("GeoNet stale acquisition time");
    const retained = await deps.sql<
      { id: string }[]
    >`SELECT record #>> '{provenance,recordId}' AS id FROM conditions.situation WHERE source_id = ${src.id} AND tombstoned_at IS NULL AND expires_at > ${at}::timestamptz LIMIT ${GEONET_MAX_EVENTS + 1}`;
    if (retained.length > GEONET_MAX_EVENTS)
      throw new Error("GeoNet retained-event budget exhausted");
    const acquired = await acquireGeonet(
      src,
      deps.fetch,
      at,
      retained.map((r) => r.id),
      prior?.covered_until ? new Date(prior.covered_until).toISOString() : undefined,
      deps.signal,
      async (url, body) => {
        const tier = rawTierFor(src, "feed");
        if (deps.raw && tier)
          await deps.raw.capture(
            { sourceId: src.id, fetchId: attempt, fetchedAt: new Date(at), tier, url },
            body,
            { url, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length },
          );
      },
      prior?.revisions,
    );
    const payloadBytes = Object.values(acquired.payloads)
      .flat()
      .reduce((n, b) => n + b.length, 0);
    if (deps.parseProcess && payloadBytes >= deps.parseProcess.minBytes) {
      const parsed = await deps.parseProcess.parse({
        feed: src,
        payloads: Object.fromEntries(
          Object.entries(acquired.payloads).map(([role, bodies]) => [
            role,
            bodies.map((data) => ({ data, gzipped: false })),
          ]),
        ),
        ctx: { fetchedAt: at, cadenceSec: src.cadenceSec, reference: {} },
      });
      // The acquisition validates durable authority; the child must reproduce the same drafts.
      const expected = new Map(acquired.drafts.map((d) => [String(d["id"]), d]));
      const drafts = parsed.output.situations.filter((d) => expected.has(String(d["id"])));
      if (
        drafts.length !== expected.size ||
        drafts.some((d) => JSON.stringify(d) !== JSON.stringify(expected.get(String(d["id"]))))
      )
        throw new Error("GeoNet child/acquisition draft disagreement");
      acquired.drafts = drafts;
    }
    const summary = await deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
      const [latest] = await tx<
        { covered_until: string }[]
      >`SELECT covered_until::text FROM conditions.geonet_coverage WHERE source_id = ${src.id}`;
      if (latest?.covered_until !== prior?.covered_until)
        throw new Error("Concurrent GeoNet poll advanced coverage");
      const ctx = {
        ...deps.model,
        now: at,
        complete: false,
        fetchId: attempt,
        payloadHashes: acquired.hashes,
        captureEvidence: "acquired" as const,
      };
      const drafts = acquired.drafts.map((d) => stampAttribution(d, src, new Date(at)));
      const result = await writeSnapshotIn(tx, src.id, { situations: drafts }, ctx);
      if (result.rejected.length) throw new Error("GeoNet canonical validation rejected a record");
      const terminalIds = acquired.terminal.map((id) => `oc:situation:${src.id}:${id}`);
      const deletions = await tx<
        { id: string }[]
      >`SELECT id FROM conditions.situation WHERE source_id = ${src.id} AND tombstoned_at IS NULL AND id = ANY(${terminalIds}::text[])`;
      const deleted = deletions.map((r) => r.id);
      await tombstoneRecords(tx, "situation", deleted, "withdrawn", ctx, result);
      const expired = await tx<
        { id: string }[]
      >`SELECT id FROM conditions.situation WHERE source_id = ${src.id} AND tombstoned_at IS NULL AND expires_at <= ${at}::timestamptz`;
      await tombstoneRecords(
        tx,
        "situation",
        expired.map((r) => r.id),
        "expired",
        ctx,
        result,
      );
      await tx`INSERT INTO conditions.geonet_coverage (source_id, covered_from, covered_until, revisions) VALUES (${src.id}, ${acquired.coveredFrom}, ${at}, ${tx.json(acquired.revisions as never)}) ON CONFLICT (source_id) DO UPDATE SET covered_from = EXCLUDED.covered_from, covered_until = EXCLUDED.covered_until, revisions = EXCLUDED.revisions`;
      const [{ n }] = await tx<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM conditions.situation WHERE source_id = ${src.id} AND tombstoned_at IS NULL`;
      await upsertSourceStatus(tx, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        outcome: n > 0 ? "changed" : "complete_empty",
        attemptAt: at,
        attemptId: attempt,
        networkValidated: true,
        payloadHashes: acquired.hashes,
        publication: {
          activeEvents: n,
          rowCount: n,
          inserted: result.counts.situation.created + result.counts.situation.restored,
          updated: result.counts.situation.updated,
          deleted: deleted.length,
          rejected: 0,
        },
      });
      return result;
    });
    return {
      count:
        summary.counts.situation.created +
        summary.counts.situation.restored +
        summary.counts.situation.updated,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await upsertSourceStatus(deps.sql, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: "error",
      attemptAt: at,
      attemptId: attempt,
      error,
    });
    return { count: 0, durationMs: Date.now() - started, error };
  }
}
