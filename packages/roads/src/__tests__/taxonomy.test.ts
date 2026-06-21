import { describe, expect, it } from "vitest";
import { mapSourceType } from "../taxonomy.js";

describe("mapSourceType", () => {
  it("maps datex2 accident to accident/incident/unplanned", () => {
    const result = mapSourceType("datex2", "accident");
    expect(result).toEqual({ type: "accident", category: "incident", isPlanned: false });
  });

  it("is case-insensitive — Accident works", () => {
    const result = mapSourceType("datex2", "Accident");
    expect(result).toEqual({ type: "accident", category: "incident", isPlanned: false });
  });

  it("strips sit: namespace prefix from value", () => {
    const result = mapSourceType("datex2", "sit:Accident");
    expect(result).toEqual({ type: "accident", category: "incident", isPlanned: false });
  });

  it("maps RoadOrCarriagewayOrLaneManagement to lane_closure", () => {
    const result = mapSourceType("datex2", "RoadOrCarriagewayOrLaneManagement");
    expect(result).toEqual({ type: "lane_closure", category: "incident", isPlanned: false });
  });

  it("maps sit:RoadOrCarriagewayOrLaneManagement (prefixed) to lane_closure", () => {
    const result = mapSourceType("datex2", "sit:RoadOrCarriagewayOrLaneManagement");
    expect(result).toEqual({ type: "lane_closure", category: "incident", isPlanned: false });
  });

  it("maps VehicleObstruction to broken_down_vehicle", () => {
    expect(mapSourceType("datex2", "VehicleObstruction")).toEqual({
      type: "broken_down_vehicle",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps SpeedManagement to speed_restriction", () => {
    expect(mapSourceType("datex2", "SpeedManagement")).toEqual({
      type: "speed_restriction",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps ReroutingManagement to detour", () => {
    expect(mapSourceType("datex2", "ReroutingManagement")).toEqual({
      type: "detour",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps GeneralObstruction to obstruction", () => {
    expect(mapSourceType("datex2", "GeneralObstruction")).toEqual({
      type: "obstruction",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps MaintenanceWorks to roadworks (isPlanned:true)", () => {
    expect(mapSourceType("datex2", "MaintenanceWorks")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps ConstructionWorks to roadworks (isPlanned:true)", () => {
    expect(mapSourceType("datex2", "ConstructionWorks")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps GeneralNetworkManagement to other", () => {
    expect(mapSourceType("datex2", "GeneralNetworkManagement")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps unknown type to other", () => {
    expect(mapSourceType("datex2", "SomethingUnknown")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps completely empty string to other", () => {
    expect(mapSourceType("datex2", "")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });
});
