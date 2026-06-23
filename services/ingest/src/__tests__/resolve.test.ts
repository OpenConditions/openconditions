import { afterEach, describe, expect, it, vi } from "vitest";
import type { Observation } from "@openconditions/core";
import type { MapMatchClient } from "@openconditions/openlr";
import { resolveOpenLr, clearResolveCache } from "../pipeline/resolve.js";

vi.mock("@openconditions/openlr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openconditions/openlr")>();
  return {
    ...actual,
    decodeOpenLrBinary: vi
      .fn()
      .mockReturnValue({ type: "line", points: [], positiveOffset: 0, negativeOffset: 0 }),
  };
});

const FAKE_OPENLR = "ABcDefGHiJkL==";

const LINE_GEOM = {
  type: "LineString" as const,
  coordinates: [
    [4.75, 52.37],
    [4.76, 52.38],
  ],
};

// `externalRefs` is a RoadEvent field, not on the base Observation type.
// Cast overrides so the test helpers can set it without TypeScript complaining.
type WithOpenlr = Observation & { externalRefs?: { openlr?: string } };

function makeEvent(id: string, overrides: Partial<WithOpenlr> = {}): Observation {
  return {
    id,
    source: "test",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    status: "active",
    origin: { kind: "feed", attribution: { provider: "T", license: "CC0" } },
    dataUpdatedAt: "2024-01-01T00:00:00Z",
    fetchedAt: "2024-01-01T00:00:00Z",
    isStale: false,
    geometry: { type: "Point", coordinates: [4.75, 52.37] } as unknown as Observation["geometry"],
    ...overrides,
  } as Observation;
}

function fakeClient(returnGeom: typeof LINE_GEOM | null): MapMatchClient {
  return {
    resolve: vi.fn().mockResolvedValue(returnGeom),
  };
}

afterEach(() => {
  clearResolveCache();
});

describe("resolveOpenLr", () => {
  it("passes through events that already have geometry", async () => {
    const ev = makeEvent("ev1");
    const client = fakeClient(LINE_GEOM);
    const { resolved, dropped } = await resolveOpenLr([ev], client);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toBe(ev);
    expect(dropped).toBe(0);
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("resolves an OpenLR event and fills its geometry on success", async () => {
    const ev = makeEvent("ev2", {
      geometry: undefined as unknown as Observation["geometry"],
      externalRefs: { openlr: FAKE_OPENLR },
    });
    const client = fakeClient(LINE_GEOM);
    const { resolved, dropped } = await resolveOpenLr([ev], client);
    expect(dropped).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.geometry).toEqual(LINE_GEOM);
    expect(client.resolve).toHaveBeenCalledOnce();
  });

  it("drops an event and increments dropped when the resolver returns null", async () => {
    const ev = makeEvent("ev3", {
      geometry: undefined as unknown as Observation["geometry"],
      externalRefs: { openlr: FAKE_OPENLR },
    });
    const client = fakeClient(null);
    const { resolved, dropped } = await resolveOpenLr([ev], client);
    expect(resolved).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("caches a successful resolution — client called only once for repeated openlr string", async () => {
    const ev1 = makeEvent("ev4a", {
      geometry: undefined as unknown as Observation["geometry"],
      externalRefs: { openlr: FAKE_OPENLR },
    });
    const ev2 = makeEvent("ev4b", {
      geometry: undefined as unknown as Observation["geometry"],
      externalRefs: { openlr: FAKE_OPENLR },
    });
    const client = fakeClient(LINE_GEOM);
    const { resolved } = await resolveOpenLr([ev1, ev2], client);
    expect(resolved).toHaveLength(2);
    expect(client.resolve).toHaveBeenCalledOnce();
  });

  it("drops all unresolved events when client is null (resolver not configured)", async () => {
    const ev = makeEvent("ev5", {
      geometry: undefined as unknown as Observation["geometry"],
      externalRefs: { openlr: FAKE_OPENLR },
    });
    const { resolved, dropped } = await resolveOpenLr([ev], null);
    expect(resolved).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});
