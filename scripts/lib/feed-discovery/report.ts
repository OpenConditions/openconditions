import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FEEDS_DIR } from "../catalog-paths.js";
import type { Report } from "./model.js";
import { redactUrl } from "./normalize.js";

function escapeMarkdown(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip unsafe metadata control characters.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[\\`*_[\]{}()#+.!|~-]/g, "\\$&")
  );
}
function link(value: string): string {
  const url = redactUrl(value);
  if (!/^https?:/.test(url)) return escapeMarkdown(url);
  // Escape link syntax in both label and href. Only URL schemes vetted above are linked.
  const target = url.replace(
    /[<>()[\]\\\s]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${escapeMarkdown(url)}](${target})`;
}
export function markdown(report: Report): string {
  const lines = [
    "# Catalog discovery",
    `Generated: ${escapeMarkdown(report.generatedAt)}. Completeness: ${report.complete ? "complete within supported scope" : "partial"}. Every candidate has status needs_review.`,
    "",
    ...report.limitations.map((v) => `- ${escapeMarkdown(v)}`),
    "",
    `Inventory: ${report.inventory.feeds} baked definitions. ${escapeMarkdown(report.inventory.scope)}.`,
    "",
    `Excluded as no OC domain: ${report.excluded.no_oc_domain}. Identity collisions retained: ${report.collisions}.`,
    "",
    "## Catalog observations",
    "",
  ];
  for (const catalog of report.catalogs) {
    lines.push(
      `- ${catalog.catalog}: ${catalog.complete ? "complete" : "incomplete"}; ${catalog.datasets} datasets, ${catalog.distributions} distributions; ${escapeMarkdown(catalog.scope)}. Diagnostics: ${catalog.diagnostics.join(", ") || "none"}.`,
    );
    if (catalog.limits)
      lines.push(
        `  Limits: ${catalog.limits.pages} pages, ${catalog.limits.datasets} datasets, ${catalog.limits.responseBytes} bytes/response, ${catalog.limits.totalBytes} bytes/catalog, ${catalog.limits.requestMs} ms/request, ${catalog.limits.catalogMs} ms/catalog.`,
      );
    for (const url of catalog.metadataUrls) lines.push(`  Metadata request: ${link(url)}`);
  }
  lines.push("", "## Review queue", "");
  for (const c of report.candidates) {
    lines.push(
      `### ${escapeMarkdown(c.title || "Untitled dataset")}`,
      "",
      `Status: needs_review. Priority: ${c.priority}. Catalog: ${c.catalog}.`,
      "",
      `Evidence: ${link(c.metadataUrl)}. Dataset: ${escapeMarkdown(c.datasetId)}. Distribution: ${escapeMarkdown(c.distributionId || c.id)}.`,
      "",
      `Countries: ${c.countries.map(escapeMarkdown).join(", ") || "unknown"}. Domain hints: ${c.domains.map((v) => escapeMarkdown(v.domain)).join(", ") || "unknown"}.`,
      "",
      `License: ${escapeMarkdown(c.license.id || c.license.state)}; OC public policy: ${c.license.public ? "potentially public (access still unqualified)" : "not established"}; origin: ${c.licenses.origin}.`,
      "",
      `Declared license: ${c.licenses.declarations.map(escapeMarkdown).join(", ") || "absent"}. Rights/access/usage: ${[...c.rights, ...c.accessConditions, ...c.usageConditions].map(escapeMarkdown).join(", ") || "unknown"}.`,
      "",
      `Format/standard: ${[...c.formats, ...c.standards].map(escapeMarkdown).join(", ") || "unknown"}. Protocol/communication: ${[...c.protocols, ...c.communication].map(escapeMarkdown).join(", ") || "unknown"}.`,
      "",
      `Publisher: ${escapeMarkdown(c.publisher) || "unknown"}. Declared update frequency: ${c.frequency.map(escapeMarkdown).join(", ") || "unknown"}. Catalog modified: ${escapeMarkdown(c.modified) || "unknown"} (not payload freshness).`,
      "",
      `Reasons: ${c.reasons.map(escapeMarkdown).join("; ")}. Caveats: ${c.caveats.map(escapeMarkdown).join("; ")}.`,
      "",
    );
    for (const [label, urls] of [
      ["Access URL", c.accessUrls],
      ["Download URL", c.downloadUrls],
      ["Sample only (never fetched)", c.sampleUrls],
    ] as const)
      for (const url of urls) lines.push(`${label}: ${link(url)}`, "");
    if (c.overlap.length)
      lines.push(
        `Overlap: ${c.overlap.map((v) => `${escapeMarkdown(v.feedId)} (${escapeMarkdown(v.reason)}${v.disabled ? ", disabled" : ""})`).join("; ")}.`,
        "",
      );
    if (c.relatedCandidates.length)
      lines.push(
        `Same endpoint in another catalog: ${c.relatedCandidates.map(escapeMarkdown).join("; ")}.`,
        "",
      );
    if (c.description) lines.push(escapeMarkdown(c.description), "");
  }
  return `${lines.join("\n")}\n`;
}
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
/** Resolve parent symlinks before writing; a report must never overwrite baked feed definitions. */
export async function validateOutput(value: string): Promise<string> {
  const requested = path.resolve(value),
    root = await realpath(FEEDS_DIR);
  if (/\.jsonc$/i.test(requested) || within(requested, path.resolve(FEEDS_DIR)))
    throw new Error("unsafe_output");
  const parent = await realpath(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  if (within(destination, root)) throw new Error("unsafe_output");
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() && within(await realpath(destination), root))
      throw new Error("unsafe_output");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}
export async function writeReport(value: string, contents: string): Promise<void> {
  const destination = await validateOutput(value),
    temporary = path.join(path.dirname(destination), `.oc-discovery-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
