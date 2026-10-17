import { beforeEach, describe, expect, it } from "vitest";
import { __resetSkips, addSkips, drainSkipped, recordSkipped, skippedRecords } from "../skips.js";

describe("skip tally", () => {
  beforeEach(() => __resetSkips());

  it("counts per source and reason, and drains once", () => {
    recordSkipped("a", "malformed");
    recordSkipped("a", "malformed", 2);
    recordSkipped("a", "unknown_value", 4);
    recordSkipped("b", "no_geometry", 0);
    expect(drainSkipped("b")).toEqual({});
    expect(drainSkipped("a")).toEqual({ malformed: 3, unknown_value: 4 });
    expect(drainSkipped("a")).toEqual({});
  });

  it("counts dropped records apart from unread values", () => {
    expect(
      skippedRecords({ no_geometry: 1, unknown_type: 2, malformed: 3, unknown_value: 9 }),
    ).toBe(6);
    expect(addSkips({ malformed: 1 }, { malformed: 2, unknown_type: 1 })).toEqual({
      malformed: 3,
      unknown_type: 1,
    });
  });
});
