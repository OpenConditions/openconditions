import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { maritimeModule } from "../module.js";

const registry = buildRegistry([kernelModule, maritimeModule]);

const base = (cls: "feature" | "observation" | "offer", localId: string) => ({
  id: `oc:${cls}:us-wa-wsf:${localId}`,
  temporality: cls === "observation" ? "live" : "static",
  location: {
    geometry: { type: "Point", coordinates: [-122.6793, 48.5071] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    origin: "feed",
    sourceId: "us-wa-wsf",
    sourceFormat: "derived",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "Washington State Ferries", license: "WSDOT-traveler-information" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-29T21:25:00Z" },
});

const terminal = (id: string) => ({ class: "feature", id: `oc:feature:us-wa-wsf:terminal-${id}` });
const route = {
  ...base("feature", "route-ana-sj"),
  class: "feature",
  kind: "ferry_route",
  name: [{ lang: "en", text: "Anacortes / San Juan Islands" }],
  lifecycle: "operational",
  components: [
    {
      key: "1-15",
      kind: "ferry_leg",
      details: { kind: "ferry_leg", v: 1, from: terminal("1"), to: terminal("15") },
    },
  ],
  details: {
    kind: "ferry_route",
    v: 1,
    terminals: [terminal("1"), terminal("15")],
    vehicleCapable: true,
  },
};

function sailing(property: string, result: object, qualifiers?: object) {
  const draft = {
    ...base("observation", "x"),
    class: "observation",
    kind: "observation",
    property,
    subject: { kind: "feature", featureId: route.id, componentKey: "1-15" },
    ...(qualifiers === undefined ? {} : { qualifiers }),
    result,
    phenomenonTime: { instant: "2026-09-29T21:20:00Z" },
    aggregation: "instantaneous",
  };
  return { ...draft, id: observationId("us-wa-wsf", draft as never) };
}

describe("maritime module", () => {
  it("registers routes with their legs, and terminals", () => {
    expect(registry.validateDraft(route).ok).toBe(true);
    expect(registry.kind("feature", "ferry_terminal")?.linking?.idSchemes).toContain(
      "netex:stop_place",
    );
  });

  it("keeps a summer-only route's season", () => {
    const summer = {
      ...route,
      details: { ...route.details, season: { from: "06-15", to: "08-31" } },
    };
    expect(registry.validateDraft(summer).ok).toBe(true);
  });

  it("reports one sailing's status and free space by its departure", () => {
    const departure = { departure: "2026-09-29T22:00:00-07:00" };
    expect(
      registry.validateDraft(
        sailing(
          "ferry.status",
          { type: "category", value: "cancelled", vocabulary: "ferry_status" },
          departure,
        ),
      ).ok,
    ).toBe(true);
    expect(
      registry.validateDraft(
        sailing("ferry.status", { type: "category", value: "running", vocabulary: "ferry_status" }),
      ).ok,
    ).toBe(true);
    expect(
      registry.validateDraft(sailing("ferry.vehicle_space", { type: "count", value: 0 }, departure))
        .ok,
    ).toBe(true);
    expect(
      registry.validateDraft(sailing("ferry.vehicle_space", { type: "count", value: 0 })).ok,
    ).toBe(false);
  });

  it("registers the fare offer", () => {
    expect(registry.kind("offer", "fare")?.domain).toBe("maritime");
  });
});
