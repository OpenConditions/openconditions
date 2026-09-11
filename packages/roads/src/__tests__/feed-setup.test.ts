import { describe, expect, it } from "vitest";
import { FEED_SOURCES } from "../feeds.js";

describe("feed credential setup", () => {
  it("New York 511 documents its API-key setup", () => {
    const ny = FEED_SOURCES.find((f) => f.id === "us-ny-511");
    expect(ny?.setup?.["US_NY_511_API_KEY"]?.title).toBeTruthy();
    expect(ny?.setup?.["US_NY_511_API_KEY"]?.url).toContain("511ny.org");
  });
});
