import {
  __resetSkips,
  type CatalogFeed,
  drainSkipped,
  type FeedDefinition,
  type FeedFormat,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it } from "vitest";
import { INGEST_DOMAINS } from "../domains.js";
import * as border from "./skip-reasons/border.js";
import * as cameras from "./skip-reasons/cameras.js";
import * as charging from "./skip-reasons/charging.js";
import * as fuel from "./skip-reasons/fuel.js";
import * as hazards from "./skip-reasons/hazards.js";
import * as layouts from "./skip-reasons/layouts.js";
import * as others from "./skip-reasons/others.js";
import * as parking from "./skip-reasons/parking.js";
import * as roadsEvents from "./skip-reasons/roads-events.js";
import * as roadsFlow from "./skip-reasons/roads-flow.js";
import type { SkipExemptions, SkipSample, SkipSamples } from "./skip-reasons/sample.js";
import * as vehicles from "./skip-reasons/vehicles.js";
import * as weather from "./skip-reasons/weather.js";

/**
 * Every format of every domain must report what it drops, and why.
 *
 * A dropped record, or a value a parser cannot read, leaves no trace in what
 * the parser publishes: a feed losing every record to a renamed field looks
 * exactly like a quiet one. The skip counters make the loss visible, but only
 * where a parser records them, and a forgotten counter is as invisible as the
 * loss itself. So this gate denies by default: a format with neither a sample
 * below nor a written exemption fails, and each sample, a poll holding exactly
 * one record to drop or one value to leave unread, must make its parser
 * report exactly that one skip under the expected reason.
 */
const GROUPS = [
  roadsEvents,
  roadsFlow,
  charging,
  parking,
  cameras,
  hazards,
  fuel,
  weather,
  vehicles,
  border,
  layouts,
];

function merged<T>(parts: readonly Readonly<Record<string, T>>[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (Object.hasOwn(out, key)) throw new Error(`${key} is listed twice`);
      out[key] = value;
    }
  }
  return out;
}

const SAMPLES: SkipSamples = merged([...GROUPS.map((g) => g.SAMPLES), others.SAMPLES]);
const EXEMPT: SkipExemptions = merged(GROUPS.map((g) => g.EXEMPT));

/** Every format of the registry, keyed `<domain>/<format>`. */
const FORMATS = new Map<string, FeedFormat>(
  INGEST_DOMAINS.flatMap((domain) =>
    Object.values(domain.formats).map(
      (format) => [`${domain.id}/${format.id}`, format as FeedFormat] as const,
    ),
  ),
);

const FETCHED_AT = "2026-07-31T12:00:00Z";

/** A feed of the format as the loader resolves one, with the sample's own fields. */
function feedOf(key: string, format: FeedFormat, sample: SkipSample): CatalogFeed {
  const [domain] = key.split("/") as [string];
  const definition = {
    operator: "skipgate",
    qualifier: format.id.replace(/[^a-z0-9]+/g, "-"),
    product: format.products[0],
    name: `Skip gate ${key}`,
    format: format.id,
    tier: "authoritative",
    endpoints: Object.fromEntries(
      Object.keys(format.endpoints).map((role) => [
        role,
        { url: `https://example.test/${role}`, cadenceSec: 300 },
      ]),
    ),
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "test",
    privacyUrl: "https://example.test/privacy",
    ...sample.feed,
  } as FeedDefinition;
  const feed = toCatalogFeed(definition, {
    domain,
    region: "xx",
    file: `feeds/${domain}/xx.jsonc`,
    maintainers: [],
  });
  return { ...feed, ...sample.feed, id: `skipgate-${key.replace("/", "-")}` } as CatalogFeed;
}

function parseSample(key: string, sample: SkipSample) {
  const format = FORMATS.get(key)!;
  const feed = feedOf(key, format, sample);
  const payloads = Object.fromEntries(
    Object.entries(sample.payloads).map(([role, bodies]) => [
      role,
      (typeof bodies === "string" ? [bodies] : bodies).map((b) => Buffer.from(b)),
    ]),
  );
  const output = format.parse(feed, payloads, {
    fetchedAt: FETCHED_AT,
    cadenceSec: 300,
    reference: sample.reference ?? {},
  });
  return { output, skipped: drainSkipped(feed.id) };
}

describe("every format reports its skips by reason", () => {
  beforeEach(() => __resetSkips());

  it("every format has a sample or an exemption", () => {
    const missing = [...FORMATS.keys()].filter((key) => !(key in SAMPLES) && !(key in EXEMPT));
    expect(missing, `add a sample or a written exemption for: ${missing.join(", ")}`).toEqual([]);
  });

  it("names only formats the registry holds, each in one list", () => {
    const listed = [...Object.keys(SAMPLES), ...Object.keys(EXEMPT)];
    expect(listed.filter((key) => !FORMATS.has(key))).toEqual([]);
    expect(listed.filter((key, i) => listed.indexOf(key) !== i)).toEqual([]);
  });

  it.each(Object.keys(SAMPLES).filter((key) => FORMATS.has(key)))(
    "%s reports exactly its sample's skip",
    (key) => {
      const sample = SAMPLES[key]!;
      const { output, skipped } = parseSample(key, sample);
      expect(skipped, `${key} should report one ${sample.reason} skip`).toEqual({
        [sample.reason]: 1,
      });
      // A skip is counted once: never again among the parse's own rejected records.
      expect(output.rejected ?? 0, `${key} counts the skip as rejected too`).toBe(0);
    },
  );
});
