import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogId } from "./lib/feed-discovery/model.js";

export interface CliOptions {
  catalogs: CatalogId[];
  format: "json" | "markdown";
  output?: string;
  help: boolean;
}
export const HELP = `Usage: pnpm feeds:discover [--catalog mobidrom|belgium|latvia] [--format json|markdown] [--output PATH]

Read-only metadata discovery; candidates always need review. Repeat --catalog to select catalogs.
Defaults: all three catalogs, JSON on stdout. No distribution payloads, samples or subscriptions.
Prepare workspace dependencies first with pnpm build:domains. --help needs no builds or network.
Exit codes: 0 complete, 2 partial report written, 1 usage/internal failure.
`;
export function parseArgs(args: string[]): CliOptions {
  if (args.length === 1 && args[0] === "--help")
    return { catalogs: [], format: "json", help: true };
  const options: CliOptions = { catalogs: [], format: "json", help: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "",
      value = args[++i];
    if (!["--catalog", "--format", "--output"].includes(flag) || !value || value.startsWith("--"))
      throw new Error("usage");
    if (flag !== "--catalog" && seen.has(flag)) throw new Error("usage");
    seen.add(flag);
    if (flag === "--catalog") {
      if (
        !["mobidrom", "belgium", "latvia"].includes(value) ||
        options.catalogs.includes(value as CatalogId)
      )
        throw new Error("usage");
      options.catalogs.push(value as CatalogId);
    } else if (flag === "--format") {
      if (value !== "json" && value !== "markdown") throw new Error("usage");
      options.format = value;
    } else options.output = value;
  }
  if (!options.catalogs.length) options.catalogs = ["mobidrom", "belgium", "latvia"];
  return options;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch {
    console.error("feeds:discover: usage (run with --help)");
    return 1;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  try {
    // Domain packages export dist. Keep imports after help/argument validation; never build implicitly.
    const { discoverFeeds } = await import("./lib/feed-discovery/discover.js");
    const { markdown, writeReport, validateOutput } = await import(
      "./lib/feed-discovery/report.js"
    );
    if (options.output) await validateOutput(options.output);
    const report = await discoverFeeds({ catalogs: options.catalogs });
    const contents =
      options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : markdown(report);
    if (options.output) await writeReport(options.output, contents);
    else process.stdout.write(contents);
    return report.complete ? 0 : 2;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      console.error(
        "feeds:discover: workspace_build_required (run pnpm install --frozen-lockfile and pnpm build:domains)",
      );
    else if (error instanceof Error && error.message === "unsafe_output")
      console.error("feeds:discover: unsafe_output");
    else console.error("feeds:discover: internal_failure (inventory or output unavailable)");
    return 1;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
