import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parserFor,
  flowParserFor,
  feedToSourceDescriptor,
  roadAttributes,
  roadFlowAttributes,
  roadFeedSchema,
} from "@openconditions/roads";
import type { RoadEvent, RoadFlow } from "@openconditions/roads";
import type { Observation } from "@openconditions/core";
import {
  loadFeeds,
  registerFeedSchema,
  type DomainRegistry,
  type IngestDomain,
} from "@openconditions/ingest-framework";

// The roads schema is registered once so the framework's loadFeeds can validate
// mounted/remote descriptors without depending on @openconditions/roads.
registerFeedSchema("roads", roadFeedSchema);

// Parser/attribute dispatch — feed-independent, used by parse.ts + write-postgis.ts
// to look up a domain's parser/attributes by name. The feed set is populated
// per-boot by buildDomainRegistry(); this static entry carries none.
const roadsDispatch: IngestDomain = {
  name: "roads",
  feeds: [],
  parserFor: parserFor as IngestDomain["parserFor"],
  flowParserFor: flowParserFor as IngestDomain["flowParserFor"],
  attributes: (obs: Observation) =>
    obs.kind === "measurement"
      ? roadFlowAttributes(obs as RoadFlow)
      : roadAttributes(obs as RoadEvent),
  feedSchema: roadFeedSchema,
};

/**
 * Dispatch-only registry keyed by domain name. `feeds` is intentionally empty —
 * the scheduler receives the populated registry from buildDomainRegistry(); the
 * pipeline (parse.ts/write-postgis.ts) uses this table solely for the
 * feed-independent parser/attribute lookup.
 */
export const DOMAIN_REGISTRY: DomainRegistry = { roads: roadsDispatch };

/**
 * Resolves the baked-in roads feed directory, tolerating both layouts the code
 * runs in: the shipped bundle (`dist/index.js` → `./feeds/roads`, copied there
 * by the ingest build) and a source checkout (dev/test/liveness script →
 * the roads package's `feeds/roads`).
 */
function defaultRoadsFeedsDir(): string {
  const candidates = [
    fileURLToPath(new URL("./feeds/roads", import.meta.url)),
    fileURLToPath(new URL("../../../packages/roads/feeds/roads", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

// Where the remote-pull snapshot is vendored. A writable state dir survives
// restarts; mount a volume there for the snapshot to outlive the container.
// Only touched when remote-pull is explicitly enabled.
function roadsRemoteSnapshotPath(): string {
  const stateDir = process.env["OPENCONDITIONS_STATE_DIR"] || "/data";
  return join(stateDir, "feeds", "roads.remote-snapshot.json");
}

/**
 * Builds the runtime registry: the same parser/attribute dispatch, with each
 * domain's feed set loaded (baked-in + operator-mounted + optional remote-pull).
 * Called once in boot(), before the scheduler starts.
 */
export async function buildDomainRegistry(
  opts: { bakedInDir?: string } = {}
): Promise<DomainRegistry> {
  const feeds = await loadFeeds({
    domain: "roads",
    bakedInDir: opts.bakedInDir ?? defaultRoadsFeedsDir(),
    mountDir: process.env["OPENCONDITIONS_FEEDS_DIR"],
    remote: {
      url: process.env["OPENCONDITIONS_FEEDS_REMOTE_URL"] || "",
      enabled: process.env["OPENCONDITIONS_FEEDS_REMOTE_ENABLED"] === "true",
      snapshotPath: roadsRemoteSnapshotPath(),
    },
  });
  return { roads: { ...roadsDispatch, feeds } };
}

export { feedToSourceDescriptor };
