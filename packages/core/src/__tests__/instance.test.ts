import { describe, expect, it } from "vitest";
import { resolveInstanceId } from "../server.js";

describe("resolveInstanceId", () => {
  it("returns the trimmed env value when set", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "  node-a  " })).toBe("node-a");
  });

  it("refuses a missing, empty or whitespace-only value instead of defaulting", () => {
    for (const env of [
      {},
      { OPENCONDITIONS_INSTANCE_ID: "" },
      { OPENCONDITIONS_INSTANCE_ID: "   " },
    ]) {
      expect(() => resolveInstanceId(env)).toThrow(/OPENCONDITIONS_INSTANCE_ID is required/);
    }
  });

  it("accepts a DNS name and rejects anything else", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "maps.example.org" })).toBe(
      "maps.example.org",
    );
    for (const bad of ["a:b", "Maps.example.org", "node_a", "-node", "node-", "a..b", "a-.b"]) {
      expect(() => resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: bad })).toThrow(
        /not a valid instance id/,
      );
    }
  });
});
