import { describe, expect, it } from "vitest";
import { FEED_SOURCES } from "../feeds.js";

describe("feed credential setup", () => {
  it("every env var a keyed feed needs has a setup guide with a title", () => {
    const ny = FEED_SOURCES.find((f) => f.id === "ny-511");
    expect(ny?.setup?.["NY_511_API_KEY"]?.title).toBeTruthy();
    expect(ny?.setup?.["NY_511_API_KEY"]?.url).toContain("511ny.org");
  });
});
