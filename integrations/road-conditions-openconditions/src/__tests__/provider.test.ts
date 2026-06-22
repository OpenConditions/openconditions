import { describe, expect, it } from "vitest";
import { setup } from "../index.js";
import type { IntegrationContext, RoadConditionsProvider } from "../types.js";

const fakeRow = {
  id: "evt-001",
  source: "ndw",
  domain: "roads",
  kind: "event",
  type: "accident",
  severity: "medium",
  headline: "Lane closure on A2",
  description: "Roadwork causing single-lane traffic",
  attributes: { roads: [{ name: "A2" }], roadState: "some_lanes_closed" },
  valid_to: null,
  geojson: JSON.stringify({ type: "Point", coordinates: [5.0, 52.0] }),
  origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
  is_stale: false,
};

function makeCtx(
  rows: unknown[],
  opts?: { noDb?: boolean; capture?: (query: string, params?: unknown[]) => void }
): { ctx: IntegrationContext; registered: RoadConditionsProvider[] } {
  const registered: RoadConditionsProvider[] = [];
  const ctx: IntegrationContext = {
    db: opts?.noDb
      ? undefined
      : {
          async execute<T = unknown>(query: string, params?: unknown[]): Promise<T> {
            opts?.capture?.(query, params);
            return rows as T;
          },
        },
    cache: {
      async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    registerRoadConditionsProvider(p) {
      registered.push(p);
    },
    manifest: { dataSources: [] },
  };
  return { ctx, registered };
}

describe("road-conditions-openconditions provider", () => {
  it("setup registers exactly one provider with the expected id", () => {
    const { ctx, registered } = makeCtx([]);
    setup(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe("road-conditions-openconditions");
  });

  it("getEvents maps PostGIS rows to RoadConditionEvent[]", async () => {
    const { ctx, registered } = makeCtx([fakeRow]);
    setup(ctx);
    const events = await registered[0]!.getEvents([4.0, 51.0, 6.0, 53.0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-001",
      source: "ndw",
      provider: "",
      type: "accident",
      severity: "medium",
      headline: "Lane closure on A2",
      roadState: "some_lanes_closed",
      geometry: { type: "Point", coordinates: [5.0, 52.0] },
    });
    expect(events[0]!.roads).toEqual([{ name: "A2" }]);
    expect(events[0]!.attribution).toMatchObject({ provider: "NDW", license: "CC0-1.0" });
  });

  it("getEvents returns [] when no database is available", async () => {
    const { ctx, registered } = makeCtx([fakeRow], { noDb: true });
    setup(ctx);
    expect(await registered[0]!.getEvents([4, 51, 6, 53])).toEqual([]);
  });

  it("applies the type filter through observationsByBbox", async () => {
    let captured = "";
    const { ctx, registered } = makeCtx([], { capture: (q) => (captured = q) });
    setup(ctx);
    await registered[0]!.getEvents([4, 51, 6, 53], { types: ["accident"] });
    expect(captured).toMatch(/type = ANY/);
  });
});
