import type { CatalogFeed } from "@openconditions/ingest-framework";

export interface FeedFailure {
  feed: Pick<CatalogFeed, "id" | "name" | "domain" | "region" | "maintainers">;
  /** `error`: the feed's payload did not parse; `warning`: it could not be fetched. */
  level: "error" | "warning";
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
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters from untrusted text is this function's purpose
      .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/@/g, "@​")
      .trim()
  );
}

/**
 * Render the Markdown issue body for a set of failing feeds: one section per
 * feed with its redacted error and its maintainers as @-mentions (or a nudge to
 * add a maintainer when none are listed). Deterministic — same input, same bytes.
 *
 * `feed.name` and `message` may carry text from a catalogue edit or an
 * upstream response and are sanitized before interpolation; the id, domain and
 * region are derived tokens, and maintainer handles come from the region
 * file's trusted `maintainers` and are left as real @-mentions.
 */
export function renderReport(failures: FeedFailure[]): string {
  const lines: string[] = [
    `Automated feed-liveness check found ${failures.length} failing feed(s).`,
    "",
    "Each feed below could not be fetched or did not parse. Errors are redacted",
    "(query-string secrets stripped). Feeds whose credentials are not set are not checked.",
    "",
  ];
  for (const f of failures) {
    const mentions = f.feed.maintainers.map((m) => `@${m.github}`).join(" ");
    const maintainersLine =
      mentions || "_none listed — add a `maintainers` entry to its region file_";
    const name = sanitizeUntrusted(f.feed.name);
    const message = sanitizeUntrusted(f.message ?? "unknown error");
    lines.push(
      `## ${name} (\`${f.feed.id}\`)`,
      "",
      `- Region file: \`feeds/${f.feed.domain}/${f.feed.region}.jsonc\``,
      `- Failure: ${f.level === "error" ? "parse" : "fetch (network or HTTP)"}`,
      `- Error: ${message}`,
      `- Maintainers: ${maintainersLine}`,
      "",
    );
  }
  return lines.join("\n");
}
