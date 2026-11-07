import { pathToFileURL } from "node:url";
import {
  createFetchState,
  fetchEndpoint,
  guardedFetch,
  PUN_BUDGET,
} from "@openconditions/ingest-framework";
import { formatOf, loadIngestCatalog } from "../services/ingest/src/domains.js";

/** Full frozen mirror generation only; no publication, cache acceptance or catalogue activation. */
export async function qualifyPun(argv: readonly string[]): Promise<void> {
  const required = [
    "--full-generation",
    "--reviewed-crs-runtime",
    "--exclusive-egress-ip-single-worker",
  ];
  if (argv.length !== required.length || required.some((flag) => !argv.includes(flag)))
    throw Error(`Qualification requires explicit operator assertions: ${required.join(" ")}`);
  const REPO_CATALOG = await loadIngestCatalog({});
  const feed = [...REPO_CATALOG.feeds, ...REPO_CATALOG.disabled].find(
    (f) => f.id === "it-agid-pun-charging",
  );
  if (!feed) throw Error("PUN catalogue entry missing");
  const started = Date.now();
  const result = await fetchEndpoint(feed, "main", guardedFetch(), {
    state: createFetchState(),
    env: {
      PUN_REVIEWED_CRS_RUNTIME: "qualified",
      PUN_EGRESS_OWNERSHIP: "exclusive-ip-single-worker",
    },
  });
  if (result.status !== "fetched") throw Error("PUN full generation was not acquired");
  const output = formatOf(feed).parse(
    feed,
    { main: result.buffers },
    { fetchedAt: new Date().toISOString(), cadenceSec: feed.cadenceSec, reference: {} },
  );
  if (output.features.length === 0) throw Error("PUN empty qualification output");
  console.log(
    JSON.stringify({
      status: result.status,
      elapsedMs: Date.now() - started,
      budget: PUN_BUDGET,
      published: false,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await qualifyPun(process.argv.slice(2));
