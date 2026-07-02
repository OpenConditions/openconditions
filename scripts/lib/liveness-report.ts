import type { FeedSourceBase } from "@openconditions/ingest-framework";

export interface FeedFailure {
  feed: Pick<FeedSourceBase, "id" | "name" | "country" | "maintainers">;
  domain: string;
  failureKind?: "upstream" | "parse";
  message?: string;
}

/**
 * Neutralize a value that came from an untrusted upstream (feed error text,
 * or feed metadata echoed from an untrusted response) before it is
 * interpolated into a PUBLIC GitHub issue body: collapse newlines/control
 * characters so it can't inject extra Markdown lines, de-link any `@handle`
 * so it can't autolink a mention, and escape backticks/backslashes so it
 * can't break out of inline code formatting.
 */
function sanitizeUntrusted(value: string): string {
  return value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/@/g, "@​")
    .trim();
}

/**
 * Render the Markdown issue body for a set of failing feeds: one section per
 * feed with its redacted error and its maintainers as @-mentions (or a nudge to
 * add a maintainer when none are listed). Deterministic — same input, same bytes.
 *
 * `feed.name`, `feed.country`, and `message` originate from untrusted feed
 * data/upstream responses and are sanitized before interpolation; maintainer
 * handles come from trusted `maintainers[]` config and are left as real
 * @-mentions.
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
    const name = sanitizeUntrusted(f.feed.name);
    const country = sanitizeUntrusted(f.feed.country);
    const message = sanitizeUntrusted(f.message ?? "unknown error");
    lines.push(
      `## ${name} (\`${f.feed.id}\`)`,
      "",
      `- Domain: ${f.domain}`,
      `- Country: ${country}`,
      `- Error: ${message}`,
      `- Maintainers: ${maintainersLine}`,
      ""
    );
  }
  return lines.join("\n");
}
