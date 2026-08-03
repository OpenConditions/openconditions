import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FEED_SOURCES, type FeedSource } from "@openconditions/roads";
import {
  checkMobilithekReference,
  fetchMobilithekOffer,
  type MobilithekOfferMetadata,
  type MobilithekReferenceCheck,
} from "./lib/mobilithek-reference.ts";

const REPORT_PATH = "mobilithek-references/out.md";

export interface MobilithekReferenceOutcome {
  feed: Pick<FeedSource, "id" | "name">;
  check: MobilithekReferenceCheck;
}

type OfferFetcher = (offerId: string) => Promise<MobilithekOfferMetadata>;

function referenceFeeds(feeds: readonly FeedSource[]): FeedSource[] {
  return feeds.filter((feed) => feed.siteTable?.reference?.kind === "mobilithek");
}

export async function checkMobilithekReferences(
  feeds: readonly FeedSource[] = FEED_SOURCES,
  fetchOffer: OfferFetcher = (offerId) => fetchMobilithekOffer(offerId)
): Promise<MobilithekReferenceOutcome[]> {
  const outcomes: MobilithekReferenceOutcome[] = [];
  for (const feed of referenceFeeds(feeds)) {
    const siteTable = feed.siteTable;
    const reference = siteTable?.reference;
    if (siteTable == null || reference == null) continue;

    try {
      const metadata = await fetchOffer(reference.offerId);
      outcomes.push({
        feed: { id: feed.id, name: feed.name },
        check: checkMobilithekReference({ url: siteTable.url, reference }, metadata),
      });
    } catch (error) {
      outcomes.push({
        feed: { id: feed.id, name: feed.name },
        check: {
          status: "invalid",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return outcomes;
}

export function renderMobilithekReferenceReport(outcomes: MobilithekReferenceOutcome[]): string {
  const problems = outcomes.filter((outcome) => outcome.check.status !== "current");
  const lines = [
    `Automated Mobilithek reference-file check found ${problems.length} problem(s).`,
    "",
    "The ingest uses explicit versioned URLs for public site-table XML files.",
    "Review the suggested URL and update the feed registry if the provider has published a newer file.",
    "",
  ];

  for (const outcome of problems) {
    const { feed, check } = outcome;
    lines.push(
      `## ${feed.name} (\`${feed.id}\`)`,
      "",
      `- Status: ${check.status}`,
      `- Message: ${check.message}`,
      ...(check.configuredFileName != null
        ? [`- Configured file: \`${check.configuredFileName}\``]
        : []),
      ...(check.latestFileName != null ? [`- Latest file: \`${check.latestFileName}\``] : []),
      ...(check.latestUrl != null ? [`- Suggested URL: ${check.latestUrl}`] : []),
      ""
    );
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const outcomes = await checkMobilithekReferences();
  const problems = outcomes.filter((outcome) => outcome.check.status !== "current");
  if (problems.length === 0) {
    console.log(`[mobilithek-references] ${outcomes.length} reference file(s) current`);
    return;
  }

  await mkdir("mobilithek-references", { recursive: true });
  await writeFile(REPORT_PATH, renderMobilithekReferenceReport(outcomes), "utf8");
  console.warn(`[mobilithek-references] ${problems.length} problem(s); wrote ${REPORT_PATH}`);
  if (process.env["GITHUB_OUTPUT"]) {
    await appendFile(process.env["GITHUB_OUTPUT"], "found=true\n");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[mobilithek-references] unexpected error:", error);
    process.exitCode = 0;
  });
}
