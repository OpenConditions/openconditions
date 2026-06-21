import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { FEED_SOURCES, feedToSourceDescriptor, parserFor } from "../feeds.js";

describe("FEED_SOURCES", () => {
  it("includes an ndw entry", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw");
    expect(ndw).toBeDefined();
  });

  it("ndw entry has format datex2", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.format).toBe("datex2");
  });

  it("ndw entry has gzip:true", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.gzip).toBe(true);
  });

  it("ndw entry has license CC0-1.0", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.license).toBe("CC0-1.0");
  });
});

describe("parserFor", () => {
  it("returns parseDatexSituations for datex2", () => {
    expect(parserFor("datex2")).toBe(parseDatexSituations);
  });

  it("throws for an unsupported format", () => {
    expect(() => parserFor("open511" as never)).toThrow();
  });
});

describe("feedToSourceDescriptor", () => {
  it("maps ndw feed to a SourceDescriptor with matching license", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.license).toBe("CC0-1.0");
  });

  it("maps ndw feed id and attribution correctly", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.id).toBe("ndw");
    expect(desc.attribution).toBe("NDW / Rijkswaterstaat");
  });

  it("includes licenseUrl when present", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.licenseUrl).toBeDefined();
  });
});
