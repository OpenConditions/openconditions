import { describe, expect, it } from "vitest";
import { resolveInstanceId } from "../server.js";

describe("resolveInstanceId", () => {
  it("returns the trimmed env value when set", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "  node-a  " })).toBe("node-a");
  });

  it("falls back to 'local' when unset", () => {
    expect(resolveInstanceId({})).toBe("local");
  });

  it("falls back to 'local' for a whitespace-only value", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "   " })).toBe("local");
  });

  it("falls back to 'local' for an empty value (Compose ${VAR:-} injection)", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "" })).toBe("local");
  });

  it("accepts a hostname and rejects ids that cannot be a record-id namespace", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "maps.example.org" })).toBe(
      "maps.example.org",
    );
    for (const bad of ["a:b", "Maps.example.org", "node_a", "-node", "node-"]) {
      expect(() => resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: bad })).toThrow(
        /not a valid instance id/,
      );
    }
  });
});
