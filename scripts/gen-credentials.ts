import { readFileSync, writeFileSync } from "node:fs";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
import {
  envExampleFor,
  configSchemaPropertiesFor,
  credentialsDocFor,
} from "./lib/gen-credentials-lib.js";

export interface GenPaths {
  envExample: string;
  serviceJson: string;
  doc: string;
}

/** Splice generated configSchema.properties into service.json, preserving every other key. */
function nextServiceJson(current: string, feeds: FeedSourceBase[]): string {
  const svc = JSON.parse(current) as { configSchema?: { properties?: unknown } };
  svc.configSchema = { ...(svc.configSchema ?? {}), properties: configSchemaPropertiesFor(feeds) };
  return JSON.stringify(svc, null, 2) + "\n";
}

/** In --write mode, writes the three artifacts. In check mode, compares and collects drift. */
export function applyOrCheck(
  feeds: FeedSourceBase[],
  paths: GenPaths,
  write: boolean
): { drift: string[] } {
  const targets: [string, string][] = [
    [paths.envExample, envExampleFor(feeds)],
    [paths.serviceJson, nextServiceJson(readFileSync(paths.serviceJson, "utf8"), feeds)],
    [paths.doc, credentialsDocFor(feeds)],
  ];
  const drift: string[] = [];
  for (const [file, next] of targets) {
    const before = safeRead(file);
    if (before === next) continue;
    if (write) writeFileSync(file, next);
    else drift.push(file);
  }
  return { drift };
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { FEED_SOURCES } = await import("@openconditions/roads");
  const paths: GenPaths = {
    envExample: new URL("../.env.example", import.meta.url).pathname,
    serviceJson: new URL("../services/ingest/service.json", import.meta.url).pathname,
    doc: new URL("../docs/road-feed-credentials.md", import.meta.url).pathname,
  };
  const write = process.argv.includes("--write");
  const { drift } = applyOrCheck(FEED_SOURCES as unknown as FeedSourceBase[], paths, write);
  if (!write && drift.length > 0) {
    console.error(
      `✗ Credential metadata is out of sync:\n  ${drift.join("\n  ")}\n\nFix with:  pnpm gen:credentials --write`
    );
    process.exit(1);
  }
  if (write) console.info("✓ credential metadata regenerated");
}
