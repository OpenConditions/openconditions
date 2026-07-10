import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type OsmWay, parseOsmiumGeojsonSeq } from "@openconditions/roads";

// Same major-road set as the Overpass query, in osmium tags-filter syntax.
const HIGHWAY_TAGS = "w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link";
const DEFAULT_OSMIUM_TIMEOUT_MS = 20 * 60_000; // 20 min per invocation

export interface OsmiumDeps {
  /** osmium binary (default "osmium"; on PATH in the ingest image). */
  osmiumBin?: string;
  /** Per-invocation hard timeout (ms). */
  timeoutMs?: number;
  /** Test seam: run one osmium invocation. Production shells out. */
  runOsmium?: (args: string[]) => Promise<void>;
  /** Test seam: read the exported geojsonseq file. */
  readGeojson?: (path: string) => Promise<string>;
}

/**
 * Runs one osmium invocation with child-process hygiene: a hard timeout that
 * SIGKILLs the child, bounded stderr capture, and termination-by-signal
 * detection (an OOM shows up as a signal, not an exit code) surfaced as a
 * distinct, non-retryable error.
 */
function defaultRunOsmium(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(
          new Error(
            `osmium ${args[0]} killed by ${signal} (OOM or timeout — do not retry this run): ${stderr.trim()}`
          )
        );
      } else if (code !== 0) {
        reject(new Error(`osmium ${args[0]} exited ${code}: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Extracts major-road ways from one downloaded `.osm.pbf`, clipped to `bbox`,
 * as resolved {@link OsmWay} records. Intermediates are written into `workDir`
 * (the caller owns its cleanup): filter major roads (keeping referenced nodes)
 * → clip to bbox with complete ways → geojsonseq export → parse.
 */
export async function pbfToWays(
  pbfPath: string,
  bbox: [number, number, number, number],
  workDir: string,
  deps: OsmiumDeps = {}
): Promise<OsmWay[]> {
  const bin = deps.osmiumBin ?? "osmium";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_OSMIUM_TIMEOUT_MS;
  const run = deps.runOsmium ?? ((args: string[]) => defaultRunOsmium(bin, args, timeoutMs));
  const readGeojson = deps.readGeojson ?? ((p: string) => readFile(p, "utf8"));

  const filtered = join(workDir, "filtered.osm.pbf");
  const clipped = join(workDir, "clipped.osm.pbf");
  const geojson = join(workDir, "roads.geojsonl");
  const [w, s, e, n] = bbox;

  await run(["tags-filter", "-O", pbfPath, HIGHWAY_TAGS, "-o", filtered]);
  await run([
    "extract",
    "-O",
    "--strategy=complete_ways",
    "--bbox",
    `${w},${s},${e},${n}`,
    filtered,
    "-o",
    clipped,
  ]);
  await run([
    "export",
    "-O",
    clipped,
    "-f",
    "geojsonseq",
    "--add-unique-id=type_id",
    "--geometry-types=linestring",
    "-o",
    geojson,
  ]);

  return parseOsmiumGeojsonSeq(await readGeojson(geojson));
}
