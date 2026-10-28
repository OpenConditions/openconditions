import { describe, expect, it } from "vitest";
import { parseGeoJson } from "../geojson.js";
import { situationDrafts } from "../situation/assemble.js";
import type { SourceDescriptor } from "../types.js";

const source: SourceDescriptor = {
  id: "test-days",
  attribution: "Test",
  license: "CC0-1.0",
  timeZone: "Europe/Berlin",
  geojson: { idField: "id", defaultType: "roadworks" },
};
const [parsed] = parseGeoJson(
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: { id: "a" },
      },
    ],
  }),
  source,
);

const validityOf = (
  validFrom: string | null,
  validTo: string | null,
  over: { estimatedEnd?: string; source?: SourceDescriptor } = {},
) => {
  const event = {
    ...parsed!,
    validFrom,
    validTo,
    ...(over.estimatedEnd
      ? { situation: { ...parsed!.situation, estimatedEnd: over.estimatedEnd } }
      : {}),
  };
  const [draft] = situationDrafts([event], { source: over.source ?? source });
  return draft!["validity"] as Record<string, unknown>;
};

describe("situation validity from a source's dates", () => {
  it("reads a parser's date as written as the whole day, in the publisher's zone", () => {
    expect(validityOf("2026-10-05", "2026-11-01")).toMatchObject({
      start: "2026-10-04T22:00:00.000Z",
      end: "2026-11-01T23:00:00.000Z",
    });
  });

  it("reads dotted and GeoServer dates alike, and a source without a zone in UTC", () => {
    expect(validityOf("05.10.2026", "2026-11-01Z")).toMatchObject({
      start: "2026-10-04T22:00:00.000Z",
      end: "2026-11-01T23:00:00.000Z",
    });
    const utc: SourceDescriptor = { ...source, timeZone: undefined };
    expect(validityOf("2026-10-05", "2026-11-01", { source: utc })).toMatchObject({
      start: "2026-10-05T00:00:00.000Z",
      end: "2026-11-02T00:00:00.000Z",
    });
  });

  it("keeps a midnight a parser passes as an instant, and reads an estimated end as an end", () => {
    expect(
      validityOf("2026-10-05T00:00:00", "2026-11-01", { estimatedEnd: "2026-11-15" }),
    ).toMatchObject({
      start: "2026-10-04T22:00:00.000Z",
      end: "2026-11-01T23:00:00.000Z",
      estimatedEnd: "2026-11-15T23:00:00.000Z",
    });
  });

  it("keeps an instant a parser already read as it is", () => {
    expect(validityOf("2026-10-05T07:00:00.000Z", "2026-11-01T23:00:00.000Z")).toMatchObject({
      start: "2026-10-05T07:00:00.000Z",
      end: "2026-11-01T23:00:00.000Z",
    });
  });
});
