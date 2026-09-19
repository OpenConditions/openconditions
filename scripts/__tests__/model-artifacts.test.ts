import { describe, expect, it } from "vitest";
import { staleModelArtifacts } from "../gen-model-artifacts.ts";

describe("published model artifacts", () => {
  it("match the registry (run pnpm gen:model after a registry change)", async () => {
    expect(await staleModelArtifacts()).toEqual([]);
  });
});
