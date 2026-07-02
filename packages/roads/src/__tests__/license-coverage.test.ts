import { describe, expect, it } from "vitest";
import { licenseInfo } from "@openconditions/ingest-framework";
import { FEED_SOURCES } from "../feeds.js";

describe("license coverage", () => {
  it("every feed's license id is in the registry", () => {
    const unknown = FEED_SOURCES.filter((f) => !licenseInfo(f.license)).map(
      (f) => `${f.id}:${f.license}`
    );
    expect(unknown).toEqual([]);
  });
});
