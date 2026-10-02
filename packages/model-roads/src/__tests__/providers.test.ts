import { describe, expect, it } from "vitest";
import {
  autobahnClassification,
  digitrafficClassification,
  gddkiaClassification,
  ltaClassification,
  ohgoClassification,
  registeredClassification,
  trafikverketClassification,
  vicClassification,
} from "../classify.js";

describe("registeredClassification", () => {
  it("reads a registered kind.type[.subtype] code", () => {
    expect(registeredClassification("roadworks.works.bridge_work")).toEqual({
      kind: "roadworks",
      type: "works",
      subtype: "bridge_work",
    });
    expect(registeredClassification("incident.accident")).toEqual({
      kind: "incident",
      type: "accident",
    });
  });

  it("refuses an unregistered or malformed code", () => {
    expect(registeredClassification("roadworks.works.knitting")).toBeUndefined();
    expect(registeredClassification("roadworks.repairs")).toBeUndefined();
    expect(registeredClassification("hazard")).toBeUndefined();
    expect(registeredClassification("road_closure")).toBeUndefined();
  });
});

describe("digitrafficClassification", () => {
  it("refines a road work by its first known work type", () => {
    expect(digitrafficClassification("ROAD_WORK", undefined, ["OTHER", "BRIDGE"])).toEqual({
      kind: "roadworks",
      type: "works",
      subtype: "bridge_work",
    });
    expect(digitrafficClassification("ROAD_WORK", undefined, ["OTHER"])).toEqual({
      kind: "roadworks",
      type: "works",
    });
  });

  it("reads an announcement type before the situation type", () => {
    expect(digitrafficClassification("TRAFFIC_ANNOUNCEMENT", "ACCIDENT_REPORT")).toEqual({
      kind: "incident",
      type: "accident",
    });
    expect(digitrafficClassification("TRAFFIC_ANNOUNCEMENT", "GENERAL")).toBeUndefined();
  });

  it("classifies weight restrictions and exempted transports", () => {
    expect(digitrafficClassification("WEIGHT_RESTRICTION")).toEqual({
      kind: "restriction",
      type: "dimension",
      subtype: "weight",
    });
    expect(digitrafficClassification("EXEMPTED_TRANSPORT")).toEqual({
      kind: "incident",
      type: "vehicle_hazard",
      subtype: "abnormal_load",
    });
  });
});

describe("provider classifications", () => {
  it("LTA: reads the Type case-insensitively, a diversion names no nature", () => {
    expect(ltaClassification("Vehicle breakdown")).toEqual({
      kind: "incident",
      type: "breakdown",
      subtype: "disabled_vehicle",
    });
    expect(ltaClassification("Heavy Traffic")?.subtype).toBe("heavy");
    expect(ltaClassification("Diversion")).toBeUndefined();
    expect(ltaClassification("Something new")).toBeUndefined();
  });

  it("GDDKiA: a bridge failure outranks the typ letter", () => {
    expect(gddkiaClassification("W", false)).toEqual({ kind: "incident", type: "accident" });
    expect(gddkiaClassification("U", false)).toEqual({ kind: "roadworks", type: "works" });
    expect(gddkiaClassification("U", true)).toEqual({
      kind: "incident",
      type: "obstruction",
      subtype: "infrastructure_damage",
    });
    expect(gddkiaClassification("I", false)).toBeUndefined();
  });

  it("Trafikverket: reads the Swedish MessageType", () => {
    expect(trafikverketClassification("Olycka")).toEqual({ kind: "incident", type: "accident" });
    expect(trafikverketClassification("Avstängd väg")?.subtype).toBe("full");
    expect(trafikverketClassification("Restriktion")).toBeUndefined();
  });

  it("Autobahn: a flow item is congestion, refined by its abnormal traffic type", () => {
    expect(autobahnClassification("WARNING", { abnormalTrafficType: "QUEUING_TRAFFIC" })).toEqual({
      kind: "congestion",
      type: "congestion",
      subtype: "queuing",
    });
    expect(autobahnClassification("WARNING", {})).toEqual({
      kind: "congestion",
      type: "congestion",
    });
    expect(autobahnClassification("WARNING")).toBeUndefined();
    expect(autobahnClassification("CLOSURE_ENTRY_EXIT")?.subtype).toBe("ramp");
  });

  it("OHGO: a work zone is roadworks whatever its category, an incident reads its category", () => {
    expect(ohgoClassification("Bridge Work", true)).toEqual({
      kind: "roadworks",
      type: "works",
      subtype: "bridge_work",
    });
    expect(ohgoClassification("Lane Shift", true)).toEqual({ kind: "roadworks", type: "works" });
    expect(ohgoClassification("Road Debris", false)).toEqual({
      kind: "incident",
      type: "obstruction",
      subtype: "debris",
    });
    expect(ohgoClassification("Some Unmapped Category", false)).toBeUndefined();
  });

  it("Victoria: the most specific candidate that names a nature wins", () => {
    expect(vicClassification("Maintenance", "Roadworks")?.subtype).toBe("maintenance");
    expect(vicClassification("Incident", "Crash")).toEqual({ kind: "incident", type: "accident" });
    expect(vicClassification("Fire", undefined)).toBeUndefined();
  });
});
