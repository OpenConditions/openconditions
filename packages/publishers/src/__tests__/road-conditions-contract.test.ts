import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { segmentConditionsToJson, type SegmentConditionRow } from "../segment-conditions.js";

afterEach(() => vi.useRealTimers());

describe("OpenConditions → OpenMapX road-condition wire contract v1", () => {
  it.each(["road-conditions-v1", "road-speed-cap-v1"])(
    "emits the complete %s consumer fixture from the actual publisher",
    (name) => {
      const input = JSON.parse(
        readFileSync(new URL(`./fixtures/contracts/${name}.input.json`, import.meta.url), "utf8")
      ) as { at: string; resolverVersion: string; rows: SegmentConditionRow[] };
      const expected = JSON.parse(
        readFileSync(new URL(`./fixtures/contracts/${name}.json`, import.meta.url), "utf8")
      );
      vi.useFakeTimers();
      const at = new Date(input.at);
      vi.setSystemTime(at);
      const output = segmentConditionsToJson(input.rows, at, {
        resolverVersion: input.resolverVersion,
        evaluatedAt: at,
      });
      expect(output.conditions).toHaveLength(1);
      expect(output).toEqual(expected);
    }
  );
});
