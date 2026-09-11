import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { segmentConditionsToJson, type SegmentConditionRow } from "../segment-conditions.js";

const input = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/road-conditions-v1.input.json", import.meta.url),
    "utf8"
  )
) as { at: string; resolverVersion: string; rows: SegmentConditionRow[] };
const expected = JSON.parse(
  readFileSync(new URL("./fixtures/contracts/road-conditions-v1.json", import.meta.url), "utf8")
);

afterEach(() => vi.useRealTimers());

describe("OpenConditions → OpenMapX road-condition wire contract v1", () => {
  it("emits the complete consumer fixture from the actual publisher", () => {
    vi.useFakeTimers();
    const at = new Date(input.at);
    vi.setSystemTime(at);
    const output = segmentConditionsToJson(input.rows, at, {
      resolverVersion: input.resolverVersion,
      evaluatedAt: at,
    });
    expect(output.conditions).toHaveLength(1);
    expect(output).toEqual(expected);
  });
});
