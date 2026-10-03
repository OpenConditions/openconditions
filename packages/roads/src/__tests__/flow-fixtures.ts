import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEED_SOURCES } from "../feeds.js";
import type { FlowContext, FlowOutput, FlowSites } from "../flow-output.js";
import { parseFlows, type RoadFeed } from "../parse.js";

/** The poll instant flow tests parse at. */
export const NOW = "2026-09-18T10:00:00.000Z";
export const CTX: FlowContext = { now: NOW, cadenceSec: 60 };

export const fixture = (path: string) => readFileSync(join(import.meta.dirname, "fixtures", path));
export const text = (path: string) => fixture(path).toString("utf8");

/**
 * The catalogue entry of a flow feed, or a stand-in for a format with no live
 * feed (digitraffic, webtris) or a synthetic test source.
 */
export function flowFeed(id: string, format?: string, extra: Partial<RoadFeed> = {}): RoadFeed {
  const feed = FEED_SOURCES.find((f) => f.id === id);
  if (feed !== undefined) return { ...feed, ...(format ? { format } : {}), ...extra } as RoadFeed;
  if (format === undefined) throw new Error(`no feed ${id}; name its format`);
  return {
    id,
    attribution: id,
    country: "FI",
    license: "CC-BY-4.0",
    format,
    ...extra,
  } as RoadFeed;
}

/** One poll of a flow feed at {@link NOW}. */
export function flows(
  feed: RoadFeed,
  input: string | Buffer,
  sites?: FlowSites,
  ctx: FlowContext = CTX,
): FlowOutput {
  return parseFlows(feed, input, sites, ctx);
}

type Draft = Record<string, unknown>;

const featureIdOf = (feed: string, site: string) => `oc:feature:${feed}:${site}`;

/** The measurement-site draft of one source site. */
export function site(out: FlowOutput, feed: string, siteId: string): Draft | undefined {
  return out.features.find((f) => f["id"] === featureIdOf(feed, siteId));
}

/** The readings of one site (or one of its channels) for one property. */
export function readings(
  out: FlowOutput,
  feed: string,
  siteId: string,
  property: string,
  componentKey?: string,
): Draft[] {
  return out.observations.filter((o) => {
    const subject = o["subject"] as { featureId: string; componentKey?: string };
    return (
      o["property"] === property &&
      subject.featureId === featureIdOf(feed, siteId) &&
      subject.componentKey === componentKey
    );
  });
}

/** The single numeric value of one site-level (or channel) reading. */
export function value(
  out: FlowOutput,
  feed: string,
  siteId: string,
  property: string,
  componentKey?: string,
): unknown {
  const found = readings(out, feed, siteId, property, componentKey);
  if (found.length > 1) throw new Error(`${found.length} ${property} readings for ${siteId}`);
  const result = found[0]?.["result"] as { value?: unknown; values?: unknown } | undefined;
  return result?.value ?? result?.values;
}

/** The ids of the sites a poll produced, in order. */
export const siteIds = (out: FlowOutput, feed: string) =>
  out.features.map((f) => String(f["id"]).slice(`oc:feature:${feed}:`.length));
