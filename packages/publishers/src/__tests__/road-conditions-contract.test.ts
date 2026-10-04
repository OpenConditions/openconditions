import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROUTING_EFFECT_KINDS, type SegmentConditionRow } from "@openconditions/core";
import { readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { type Effect, isRestrictionEvidence } from "@openconditions/model";
import { parseEvents, type RoadFeed, roadsDomain } from "@openconditions/roads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { segmentConditionsToJson } from "../segment-conditions.js";
import { segmentConditionsToExclusions } from "../valhalla.js";

afterEach(() => vi.useRealTimers());

const contract = (file: string) => new URL(`./fixtures/contracts/${file}`, import.meta.url);
const readJson = (file: string) => JSON.parse(readFileSync(contract(file), "utf8"));

/**
 * Compares `actual` with the committed fixture, or rewrites the fixture when
 * `UPDATE_CONTRACTS=1` (refused under CI): a contract change is a reviewed
 * edit of both repositories' copies, never a side effect of a test run.
 */
function expectContract(file: string, actual: unknown) {
  if (process.env["UPDATE_CONTRACTS"] === "1") {
    if (process.env["CI"]) throw new Error("UPDATE_CONTRACTS is refused under CI");
    writeFileSync(contract(file), `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(readJson(file));
}

function project(rows: SegmentConditionRow[], at: Date, resolverVersion: string) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  return segmentConditionsToJson(rows, at, { resolverVersion, evaluatedAt: at });
}

const ROADS_FIXTURES = "../../../roads/src/__tests__/fixtures/";
const REPO_FEEDS = fileURLToPath(new URL("../../../../feeds", import.meta.url));

/** A road feed of the catalogue, read as a complete snapshot (the path that carries versions). */
function feed(id: string): RoadFeed {
  const { files } = readCatalogDir(REPO_FEEDS, [roadsDomain], { otherDomains: "ignore" });
  const found = files
    .flatMap((file) =>
      file.feeds.map((def) =>
        toCatalogFeed(def, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }),
      ),
    )
    .find((f) => f.id === id);
  if (!found) throw new Error(`no feed ${id}`);
  return { ...found, snapshot: { completeness: "complete" } } as RoadFeed;
}

/**
 * The routing-relevant effects real parsers produce for vehicle-specific
 * restrictions (NDW lorry and dimension records, a Fintraffic weight limit),
 * each in a copy of the eligible control row: identity, classification and
 * effect replaced, every other eligibility condition kept, and the effect's
 * own window dropped so every one is evaluated at the frozen instant.
 */
function restrictionRows(control: SegmentConditionRow): SegmentConditionRow[] {
  const drafts = [
    ...parseEvents(feed("nl-ndw-events"), [
      readFileSync(new URL(`${ROADS_FIXTURES}ndw/restrictions-v3.xml`, import.meta.url)),
    ]).situations,
    ...parseEvents(feed("fi-digitraffic-events"), [
      readFileSync(
        new URL(`${ROADS_FIXTURES}digitraffic/weight-restriction.json`, import.meta.url),
      ),
    ]).situations,
  ];
  return drafts.flatMap((draft) => {
    const own = (draft["effects"] as Effect[]) ?? [];
    const phases = (
      (draft["details"] as { phases?: { effects: Effect[] }[] }).phases ?? []
    ).flatMap((p) => p.effects);
    const severity = draft["severity"] as { label: string };
    return [...own, ...phases]
      .filter(
        (e) =>
          (ROUTING_EFFECT_KINDS as readonly string[]).includes(e.kind) || isRestrictionEvidence(e),
      )
      .map((effect) => {
        const { validity: _window, ...timeless } = effect as Effect & { validity?: unknown };
        return {
          ...control,
          record_id: String(draft["id"]),
          effect_id: effect.id,
          kind: String(draft["kind"]),
          type: String(draft["type"]),
          subtype: (draft["subtype"] as string | undefined) ?? null,
          severity: severity.label,
          effect: timeless as Effect,
        };
      });
  });
}

describe("OpenConditions → OpenMapX road-condition wire contract v2", () => {
  it.each(["road-conditions-v2", "road-speed-cap-v2"])(
    "emits the complete %s consumer fixture from the actual publisher",
    (name) => {
      const input = readJson(`${name}.input.json`) as {
        at: string;
        resolverVersion: string;
        rows: SegmentConditionRow[];
      };
      const output = project(input.rows, new Date(input.at), input.resolverVersion);
      expect(output.conditions).toHaveLength(1);
      expectContract(`${name}.json`, output);
    },
  );

  it("emits vehicle-specific restrictions that never constrain a car route", () => {
    const input = readJson("road-conditions-v2.input.json") as {
      at: string;
      resolverVersion: string;
      rows: SegmentConditionRow[];
    };
    const [control] = input.rows;
    const at = new Date(input.at);
    const restricted = restrictionRows(control!);
    const output = project([control!, ...restricted], at, input.resolverVersion);
    expect(output.conditions.length).toBeGreaterThan(5);
    expectContract("road-restrictions-v2.json", output);

    const restrictions = output.conditions.filter((c) => c.record_id !== control!.record_id);
    expect(restrictions.length).toBeGreaterThan(0);
    expect(segmentConditionsToExclusions(restrictions, { activeAt: at, evaluatedAt: at })).toEqual({
      exclude_locations: [],
      exclude_polygons: [],
      speed_caps: [],
    });
  });
});
