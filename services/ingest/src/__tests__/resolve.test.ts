import type { RecordDraft } from "@openconditions/ingest-framework";
import type { MapMatchClient } from "@openconditions/openlr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearResolveCache, resolveOpenLr } from "../pipeline/resolve.js";

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

/** A situation draft placed at a point. */
function placedDraft(local: string): RecordDraft {
  return {
    id: `oc:situation:nl-ndw-events:${local}`,
    location: {
      geometry: { type: "Point", coordinates: [4.75, 52.37] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
  };
}

/** A situation draft only an OpenLR reference places. */
function openLrDraft(local: string): RecordDraft {
  return {
    id: `oc:situation:nl-ndw-events:${local}`,
    location: {
      geometry: null,
      extent: "linear",
      geometryOrigin: "none",
      fuzziness: "exact",
      openlr: FAKE_OPENLR,
    },
  };
}

const locationOf = (draft: RecordDraft | undefined) =>
  draft?.["location"] as Record<string, unknown>;

function fakeClient(returnGeom: typeof LINE_GEOM | null): MapMatchClient {
  return { resolve: vi.fn().mockResolvedValue(returnGeom) };
}

afterEach(() => {
  clearResolveCache();
});

describe("resolveOpenLr", () => {
  it("passes through situations that already have geometry", async () => {
    const draft = placedDraft("a");
    const client = fakeClient(LINE_GEOM);
    const { resolved, dropped } = await resolveOpenLr([draft], client);
    expect(resolved).toEqual([draft]);
    expect(dropped).toBe(0);
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("places an OpenLR-only situation on the decoded geometry", async () => {
    const client = fakeClient(LINE_GEOM);
    const { resolved, dropped } = await resolveOpenLr([openLrDraft("b")], client);
    expect(dropped).toBe(0);
    expect(locationOf(resolved[0])).toMatchObject({
      geometry: LINE_GEOM,
      extent: "linear",
      geometryOrigin: "openlr_decoded",
      openlr: FAKE_OPENLR,
    });
    expect(client.resolve).toHaveBeenCalledOnce();
  });

  it("drops a situation the resolver cannot place, and names it unlocatable", async () => {
    const { resolved, dropped, unlocatable } = await resolveOpenLr(
      [openLrDraft("c")],
      fakeClient(null),
    );
    expect(resolved).toEqual([]);
    expect(dropped).toBe(1);
    expect(unlocatable).toEqual(["oc:situation:nl-ndw-events:c"]);
  });

  it("caches a successful resolution — client called only once for a repeated reference", async () => {
    const client = fakeClient(LINE_GEOM);
    const { resolved } = await resolveOpenLr([openLrDraft("d1"), openLrDraft("d2")], client);
    expect(resolved).toHaveLength(2);
    expect(client.resolve).toHaveBeenCalledOnce();
  });

  it("drops every OpenLR-only situation when no resolver is configured", async () => {
    const { resolved, dropped } = await resolveOpenLr([openLrDraft("e")], null);
    expect(resolved).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("marks a resolver failure unsafe and retries the uncached reference", async () => {
    const client = {
      resolve: vi
        .fn()
        .mockRejectedValueOnce(new Error("deadline exceeded"))
        .mockResolvedValueOnce(LINE_GEOM),
    };
    const first = await resolveOpenLr([placedDraft("placed"), openLrDraft("failed")], client);
    expect(first.failed).toBe(1);
    expect(first.resolved).toHaveLength(1);
    const retried = await resolveOpenLr([openLrDraft("failed")], client);
    expect(retried.failed).toBe(0);
    expect(locationOf(retried.resolved[0])["geometry"]).toEqual(LINE_GEOM);
    expect(client.resolve).toHaveBeenCalledTimes(2);
  });
});
