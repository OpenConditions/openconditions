import { writeFile } from "node:fs/promises";
import path from "node:path";
import { guardedFetch, resolveWithSnapshot } from "@openconditions/ingest-framework";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
// Imported from the built package barrel (not `../src/*.ts`) so the script runs
// under plain `node scripts/export-atlas.ts` — Node does not remap `.js` import
// specifiers to `.ts` source, so importing the compiled `dist` is required. Run
// `pnpm --filter @openconditions/roads build` first.
import { FEED_SOURCES, autobahnIndexResolver, wzdxRegistryResolver } from "@openconditions/roads";

/** Strip any field whose value is a function → pure, serialisable data only. */
function toPureData(feed: FeedSourceBase): FeedSourceBase {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(feed)) {
    if (typeof v === "function") continue;
    out[k] = v;
  }
  return out as FeedSourceBase;
}

/**
 * Flattens the curated feeds plus the resolved catalog outputs into one flat
 * commons list of pure-data descriptors, de-duped by id (curated wins on
 * collision). A `catalog` feed keeps its catalog pointer (it is not expanded);
 * the concrete resolver outputs are appended alongside it.
 */
export function buildAtlas(
  feeds: FeedSourceBase[],
  resolved: FeedSourceBase[][]
): FeedSourceBase[] {
  const byId = new Map<string, FeedSourceBase>();
  for (const f of feeds) byId.set(f.id, toPureData(f));
  for (const set of resolved) {
    for (const f of set) if (!byId.has(f.id)) byId.set(f.id, toPureData(f));
  }
  return [...byId.values()];
}

// The vendored snapshots live in source (not the built dist the resolvers'
// `snapshotPath` resolves to when this script imports the compiled barrel), so
// the export writes them here explicitly — this script is the single authority
// that regenerates both the atlas and the committed snapshots.
const SNAPSHOT_DIR = path.resolve(import.meta.dirname, "../src/catalog/snapshots");

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const fetchFn = offline
    ? ((async () => {
        throw new Error("offline: resolve from vendored snapshot");
      }) as unknown as typeof fetch)
    : guardedFetch();

  const resolved = [
    { file: "wzdx-registry.json", feeds: await resolveWithSnapshot(wzdxRegistryResolver, fetchFn) },
    {
      file: "autobahn-index.json",
      feeds: await resolveWithSnapshot(autobahnIndexResolver, fetchFn),
    },
  ];

  for (const { file, feeds } of resolved) {
    const snapPath = path.join(SNAPSHOT_DIR, file);
    await writeFile(snapPath, `${JSON.stringify(feeds, null, 2)}\n`);
    console.info(`[atlas] refreshed ${feeds.length} feed(s) → ${snapPath}`);
  }

  const atlas = buildAtlas(
    FEED_SOURCES,
    resolved.map((r) => r.feeds)
  );
  const out = path.resolve(import.meta.dirname, "../atlas/roads.json5");
  await writeFile(out, `${JSON.stringify(atlas, null, 2)}\n`);
  console.info(`[atlas] wrote ${atlas.length} feed descriptors → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
