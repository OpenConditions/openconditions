import { KERNEL_VERSION, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules, productionRegistry } from "../index.js";

describe("production registry", () => {
  it("assembles the kernel module first", () => {
    expect(productionModules[0]).toBe(kernelModule);
  });

  it("builds once and closes the kernel vocabularies", () => {
    const registry = productionRegistry();
    expect(productionRegistry()).toBe(registry);
    expect(registry.kernelVersion).toBe(KERNEL_VERSION);
    expect(registry.vocabulary("source_tier")).toBeDefined();
  });

  it("holds the shared source formats in the kernel and the parking ones in parking", () => {
    const formats = productionRegistry().vocabulary("source_format")!;
    for (const id of ["datex2", "geojson", "json", "csv", "overpass"]) {
      expect(formats.contributedBy[id], id).toBe("kernel");
    }
    for (const id of ["parkapi-v3", "hdb", "tfnsw"]) {
      expect(formats.contributedBy[id], id).toBe("parking");
    }
  });

  it("registers every domain OpenConditions models", () => {
    const registry = productionRegistry();
    expect(productionModules.map((m) => m.name)).toEqual([
      "kernel",
      "roads",
      "weather",
      "vehicles",
      "parking",
      "charging",
      "fuel",
      "facilities",
      "border",
      "maritime",
      "hazards",
    ]);
    expect(registry.domains().map((d) => d.code)).toEqual([
      "roads",
      "weather",
      "vehicles",
      "parking",
      "charging",
      "fuel",
      "facilities",
      "border",
      "maritime",
      "hazards",
    ]);
    expect(registry.kind("situation", "roadworks")?.domain).toBe("roads");
    expect(registry.vocabulary("source_format")!.values).toContain("datex2");
  });

  it("gives each infrastructure property the domain of what it measures", () => {
    const registry = productionRegistry();
    expect(registry.property("traffic.speed")?.domain).toBe("roads");
    expect(registry.property("road.surface_state")?.domain).toBe("weather");
    expect(registry.property("vehicle.position")?.domain).toBe("vehicles");
    expect(registry.kind("feature", "weather_station")?.traits).toContain("field_device");
  });

  it("registers every feature kind of the model, each in the domain of what it is", () => {
    const registry = productionRegistry();
    const domainOf = Object.fromEntries(registry.kinds("feature").map((k) => [k.code, k.domain]));
    expect(domainOf).toEqual({
      vms: "roads",
      camera: "roads",
      measurement_site: "roads",
      structure: "roads",
      rail_crossing: "roads",
      blackspot: "roads",
      emergency_phone: "roads",
      lane_control_gantry: "roads",
      mountain_pass: "roads",
      chain_control_zone: "roads",
      travel_time_route: "roads",
      toll_point: "roads",
      toll_section: "roads",
      weather_station: "weather",
      service_vehicle: "vehicles",
      parking_site: "parking",
      charging_site: "charging",
      fuel_station: "fuel",
      rest_area: "facilities",
      weigh_station: "facilities",
      border_crossing: "border",
      ferry_route: "maritime",
      ferry_terminal: "maritime",
    });
  });

  it("registers every situation kind of the model: road traffic in roads, warnings and hazard events in hazards", () => {
    const registry = productionRegistry();
    const domainOf = Object.fromEntries(registry.kinds("situation").map((k) => [k.code, k.domain]));
    expect(Object.keys(domainOf)).toHaveLength(17);
    expect(
      Object.entries(domainOf)
        .filter(([, domain]) => domain !== "roads")
        .map(([kind, domain]) => `${kind}:${domain}`),
    ).toEqual(["alert:hazards", "natural_hazard:hazards"]);
    expect(registry.property("fire.frp")?.domain).toBe("hazards");
    expect(registry.property("fire.frp")?.transient).toBe(true);
    expect(registry.property("fire.brightness")).toBeUndefined();
  });

  it("observes an open status on every site an operator opens and closes", () => {
    const registry = productionRegistry();
    const operated = registry
      .kinds("feature")
      .filter((k) => k.traits?.includes("operated_site"))
      .map((k) => k.code);
    expect(operated).toEqual(["toll_point", "rest_area", "weigh_station", "border_crossing"]);
  });

  it("registers the offers and the kinds they price", () => {
    const registry = productionRegistry();
    expect(registry.kinds("offer").map((k) => k.code)).toEqual([
      "toll",
      "parking_rate",
      "energy_tariff",
      "fare",
    ]);
    expect(registry.kind("feature", "parking_site")?.components).toEqual([
      "parking_area",
      "parking_space",
    ]);
    expect(registry.kind("feature", "fuel_station")?.components).toEqual(["fuel_product"]);
  });

  it("gives every facility kind rules for recognising it across sources", () => {
    const registry = productionRegistry();
    for (const kind of ["parking_site", "charging_site", "fuel_station"]) {
      const linking = registry.kind("feature", kind)?.linking;
      expect(linking?.osm?.tags.length).toBeGreaterThan(0);
      expect(linking!.alwaysMetres).toBeLessThanOrEqual(linking!.neverMetres);
    }
  });

  it("takes crowd reports of what a driver can see, and of nothing else", () => {
    const registry = productionRegistry();
    expect(
      registry
        .kinds("situation")
        .filter((k) => k.crowd !== undefined)
        .map((k) => k.code),
    ).toEqual([
      "incident",
      "roadworks",
      "closure",
      "weather_condition",
      "road_condition",
      "road_hazard",
      "equipment_fault",
      "congestion",
      "other",
    ]);
    expect(
      registry
        .properties()
        .filter((p) => p.crowd !== undefined)
        .map((p) => p.code),
    ).toEqual([
      "parking.status",
      "charging.evse_status",
      "charging.connector_status",
      "fuel.price",
      "fuel.product_available",
      "facility.open_status",
    ]);
  });

  it("names what makes two sources' components one, where sources share one", () => {
    const registry = productionRegistry();
    expect(
      registry
        .kinds("component")
        .filter((k) => k.identity !== undefined)
        .map((k) => k.code)
        .sort(),
    ).toEqual(["connector", "evse", "fuel_product", "parking_area"]);
  });
});
