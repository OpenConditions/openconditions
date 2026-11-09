import { describe, expect, test } from "vitest";
import { inspectSnapshotCompleteness } from "../pipeline/snapshot-inspection.js";

describe("qualified CSV inventory publication", () => {
  const snapshot = {
    completeness: "complete",
    csv: true,
    minimumRecords: 2,
    qualification: "qualified",
  } as const;
  test("pending qualification fails even on valid data", () => {
    expect(() =>
      inspectSnapshotCompleteness({ snapshot: { ...snapshot, qualification: "pending" } }, [
        Buffer.from("id\n1\n2\n"),
      ]),
    ).toThrow(/qualification pending/);
  });
  test("unexpected empty and shortened inventories fail before publication", () => {
    for (const value of ["", "id\n", "id\n1\n"]) {
      expect(() => inspectSnapshotCompleteness({ snapshot }, [Buffer.from(value)])).toThrow(
        /minimum/,
      );
    }
  });
  test("rejects truncated quoted cells and ragged rows", () => {
    for (const value of ['id,name\n1,"unfinished', "id,name\n1,name\n2\n"]) {
      expect(() => inspectSnapshotCompleteness({ snapshot }, [Buffer.from(value)])).toThrow(/CSV/);
    }
  });
  test("qualified bounded inventory has explicit accounting", () => {
    expect(inspectSnapshotCompleteness({ snapshot }, [Buffer.from("id\n1\n2\n")])).toEqual({
      complete: true,
      inputRecords: 2,
      completeEmpty: false,
    });
  });
});

test("partial CSV validates input without granting withdrawal authority", () => {
  expect(
    inspectSnapshotCompleteness(
      { snapshot: { completeness: "partial", csv: true, minimumRecords: 2 } },
      [Buffer.from("id\n1\n2\n")],
    ),
  ).toEqual({ complete: false, inputRecords: 2, completeEmpty: false });
});
