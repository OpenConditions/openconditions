import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEvents, parseFlows } from "../parse.js";
import { roadFeed } from "./helpers/road-feed.js";

const ndw = readFileSync(new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url), "utf8");
const drivebc = readFileSync(new URL("./fixtures/drivebc/events.json", import.meta.url));

const ndwFeed = roadFeed({
  id: "nl-ndw-events",
  region: "nl",
  format: "datex2",
  attribution: "NDW",
  license: "CC0-1.0",
  snapshot: { completeness: "complete" },
});

const drivebcFeed = roadFeed({
  id: "ca-bc-drivebc-events",
  region: "ca",
  format: "open511",
  attribution: "DriveBC",
  license: "LicenseRef-OGL-BC",
});

describe("parseEvents", () => {
  it("drafts the situations of a complete snapshot and accounts for every record", () => {
    const out = parseEvents(ndwFeed, [Buffer.from(ndw)]);
    expect(out.situations.length).toBeGreaterThan(0);
    expect(
      out.situations.every((s) => String(s["id"]).startsWith("oc:situation:nl-ndw-events:")),
    ).toBe(true);
    expect(out.records).toMatchObject({ unlocatable: 0, unlocatableSituations: [], duplicates: 0 });
    expect(out.records!.accepted).toBe(out.records!.uniqueCount);
  });

  it("counts the accepted records each situation folds, so a lost situation can be counted in records", () => {
    const out = parseEvents(ndwFeed, [Buffer.from(ndw)]);
    const folded = out.records!.situationRecords;
    expect(Object.keys(folded).sort()).toEqual(out.situations.map((s) => String(s["id"])).sort());
    expect(Object.values(folded).reduce((a, b) => a + b, 0)).toBe(out.records!.accepted);
    expect(folded["oc:situation:nl-ndw-events:RWS01_SM1080891_D2_WWA"]).toBe(3);
  });

  it("names the situation of a record it could not place, so the poll cannot end it", () => {
    const record = ndw
      .match(/<sit:situationRecord\b[\s\S]*?<\/sit:situationRecord>/g)!
      .find((r) => r.includes('version="133"'))!;
    const unplaced = record.replace(
      /<sit:locationReference\b[\s\S]*?<\/sit:locationReference>/g,
      "",
    );
    const out = parseEvents(ndwFeed, [Buffer.from(ndw.replace(record, unplaced))]);
    expect(out.records?.unlocatable).toBe(1);
    expect(out.records?.unlocatableSituations).toContain(
      "oc:situation:nl-ndw-events:RWS01_SM1080891_D2_WWA",
    );
    const id = record.match(/\bid="([^"]+)"/)![1]!;
    expect(out.records?.unlocatableRecords).toEqual([id]);
  });

  it("keeps a DATEX comment in every language the publisher wrote it in, in its order", () => {
    const comment =
      "<sit:generalPublicComment><com:comment><com:values>" +
      '<com:value lang="nl">Weg dicht</com:value><com:value lang="en">Road closed</com:value>' +
      "</com:values></com:comment></sit:generalPublicComment>";
    const xml = ndw.replace(/(<sit:situationRecord\b[^>]*>)/g, `$1${comment}`);
    const out = parseEvents(ndwFeed, [Buffer.from(xml)]);
    expect(out.situations[0]!["headline"]).toEqual([
      { lang: "nl", text: "Weg dicht" },
      { lang: "en", text: "Road closed" },
    ]);
  });

  it("drafts a poll as of the instant it was fetched, so a replay reads it as the poll did", () => {
    const at = "2020-01-01T00:00:00.000Z";
    const out = parseEvents(ndwFeed, [Buffer.from(ndw)], { fetchedAt: at });
    expect(out.situations.map((s) => (s["freshness"] as { fetchedAt: string }).fetchedAt)).toEqual(
      out.situations.map(() => at),
    );
    // DriveBC's planned works all start after 2020, so as of then each is still to come.
    const planned = parseEvents(drivebcFeed, [drivebc], { fetchedAt: at }).situations.filter(
      (s) => s["planned"] === true && (s["validity"] as { start?: string }).start !== undefined,
    );
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((s) => s["temporality"] === "scheduled")).toBe(true);
  });

  it("folds every payload of a poll into one snapshot", () => {
    const once = parseEvents(ndwFeed, [Buffer.from(ndw)]);
    const twice = parseEvents(ndwFeed, [Buffer.from(ndw), Buffer.from(ndw)]);
    const shape = (s: Record<string, unknown>) => [s["id"], s["effects"]];
    expect(twice.situations.map(shape)).toEqual(once.situations.map(shape));
    expect(twice.records?.duplicates).toBe(once.records!.uniqueCount);
  });

  it("drafts a feed without a snapshot contract with no record accounting", () => {
    const out = parseEvents(drivebcFeed, [drivebc]);
    expect(out.situations.length).toBeGreaterThan(0);
    expect(out.records).toBeUndefined();
  });
});

describe("parseFlows", () => {
  it("refuses a payload the flow parser cannot read at all", () => {
    const feed = roadFeed({
      id: "nl-ndw-flow",
      region: "nl",
      product: "flow",
      format: "datex2-measured",
      attribution: "NDW",
      license: "CC0-1.0",
    });
    expect(() =>
      parseFlows(feed, "not xml", undefined, { now: "2026-09-18T10:00:00Z", cadenceSec: 60 }),
    ).toThrow("hard parse failure");
  });
});
