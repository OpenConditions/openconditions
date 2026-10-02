import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { RevisionedClass } from "../db/record-schema.js";
import { readRecord, readRevisions } from "../db/records.js";

const neverQueried = new Proxy({} as postgres.Sql, {
  get() {
    throw new Error("queried the database");
  },
});
const smuggled = "situation WHERE true; --" as RevisionedClass;

describe("record reads", () => {
  it("refuse a class that is not a record table before querying", async () => {
    await expect(readRecord(neverQueried, smuggled, "x")).rejects.toThrow("not a record class");
    await expect(readRevisions(neverQueried, smuggled, "x")).rejects.toThrow("not a record class");
  });
});
