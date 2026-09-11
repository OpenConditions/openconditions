import { writeFile } from "node:fs/promises";
import path from "node:path";
import { guardedFetch, resolveWithSnapshot } from "@openconditions/ingest-framework";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
// Imported from the built package barrel (not `../src/*.ts`) so the script runs
// under plain `node scripts/export-atlas.ts` — Node does not remap `.js` import
// specifiers to `.ts` source, so importing the compiled `dist` is required. Run
// `pnpm --filter @openconditions/roads build` first.
import {
  FEED_SOURCES,
  autobahnIndexResolver,
  wzdxRegistryResolver,
  roadFeedSchema,
} from "@openconditions/roads";

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
  for (const layer of [feeds, ...resolved]) {
    const ids = new Set<string>();
    for (const raw of layer) {
      const feed = roadFeedSchema.parse(raw);
      if (ids.has(feed.id)) throw new Error(`duplicate atlas feed id: ${feed.id}`);
      ids.add(feed.id);
      if (!byId.has(feed.id)) byId.set(feed.id, feed);
    }
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

  // Validate the complete export before replacing either committed artifact.
  const atlas = buildAtlas(
    FEED_SOURCES,
    resolved.map((r) => r.feeds)
  );

  for (const { file, feeds } of resolved) {
    const snapPath = path.join(SNAPSHOT_DIR, file);
    await writeFile(snapPath, `${JSON.stringify(feeds, null, 2)}\n`);
    console.info(`[atlas] refreshed ${feeds.length} feed(s) → ${snapPath}`);
  }

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
