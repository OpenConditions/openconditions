import type { FeedSourceBase } from "@openconditions/ingest-framework";

export interface FeedFailure {
  feed: Pick<FeedSourceBase, "id" | "name" | "country" | "maintainers">;
  domain: string;
  failureKind?: "upstream" | "parse";
  message?: string;
}

/**
 * Render the Markdown issue body for a set of failing feeds: one section per
 * feed with its redacted error and its maintainers as @-mentions (or a nudge to
 * add a maintainer when none are listed). Deterministic — same input, same bytes.
 */
export function renderReport(failures: FeedFailure[]): string {
  const lines: string[] = [
    `Automated feed-liveness check found ${failures.length} failing keyless feed(s).`,
    "",
    "Each feed below fetched or parsed with no usable data. Errors are redacted",
    "(query-string secrets stripped). Keyed feeds are not checked in CI.",
    "",
  ];
  for (const f of failures) {
    const mentions = (f.feed.maintainers ?? []).map((m) => `@${m.github}`).join(" ");
    const maintainersLine = mentions || "_none listed — add a `maintainers` entry to this feed_";
    lines.push(
      `## ${f.feed.name} (\`${f.feed.id}\`)`,
      "",
      `- Domain: ${f.domain}`,
      `- Country: ${f.feed.country}`,
      `- Error: ${f.message ?? "unknown error"}`,
      `- Maintainers: ${maintainersLine}`,
      ""
    );
  }
  return lines.join("\n");
}
