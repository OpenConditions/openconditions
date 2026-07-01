import { describe, expect, it } from "vitest";
import { FRAMEWORK_VERSION } from "../index.js";

describe("ingest-framework", () => {
  it("exports a version string", () => {
    expect(typeof FRAMEWORK_VERSION).toBe("string");
  });
});
