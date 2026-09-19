import { describe, expect, it } from "vitest";
import { anyVocab, enumOf } from "../kernel/vocab.js";

describe("vocabulary resolution", () => {
  it("closes a value list and rejects everything else", () => {
    const schema = enumOf(["a", "b"]);
    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("c").success).toBe(false);
  });

  it("accepts nothing for an empty vocabulary", () => {
    expect(enumOf([]).safeParse("a").success).toBe(false);
  });

  it("builds static types with any non-empty string", () => {
    expect(anyVocab("anything").safeParse("x").success).toBe(true);
    expect(anyVocab("anything").safeParse("").success).toBe(false);
  });
});
