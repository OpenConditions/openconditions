import { describe, expect, it } from "vitest";
import { contentFields } from "../content-hash.js";
import { CREATED, computeChangeKinds, TOMBSTONED } from "../registry/change.js";
import { closure, incidentDraft, registry, stored } from "./fixtures.js";

const situation = () => stored(incidentDraft());

describe("computeChangeKinds", () => {
  it("names the first revision created and the tombstone tombstoned", () => {
    expect(computeChangeKinds(registry, undefined, situation())).toEqual([CREATED]);
    const tomb = { ...situation(), tombstone: { reason: "expired", at: "2026-09-18T11:00:00Z" } };
    expect(computeChangeKinds(registry, situation(), tomb)).toEqual([TOMBSTONED]);
  });

  it("lists every changed part in registry order", () => {
    const next = {
      ...situation(),
      severity: { label: "critical", source: "declared", declaredRaw: "highest" },
      effects: [closure("SIT-1/closure"), closure("SIT-1/closure:2")],
    };
    expect(computeChangeKinds(registry, situation(), next)).toEqual([
      "severity_change",
      "effects_change",
    ]);
  });

  it("ignores derived fields", () => {
    const next = { ...situation(), revision: 2, recordedAt: "2026-09-18T12:00:00Z" };
    expect(computeChangeKinds(registry, situation(), next)).toEqual([]);
  });

  it("separates a geometry change from other location changes", () => {
    const moved = {
      ...situation(),
      location: { ...situation().location, geometry: { type: "Point", coordinates: [5, 52] } },
    };
    expect(computeChangeKinds(registry, situation(), moved)).toEqual(["geometry_change"]);
    const renamed = {
      ...situation(),
      location: { ...situation().location, fuzziness: "low_res" },
    };
    expect(computeChangeKinds(registry, situation(), renamed)).toEqual(["location_change"]);
  });

  it.each(["situation", "feature", "offer"] as const)(
    "watches every content field of a %s",
    (cls) => {
      const base = { ...situation(), class: cls };
      for (const key of contentFields(cls)) {
        if (key === "id" || key === "class") continue;
        const next = { ...base, [key]: { changed: key } };
        expect(computeChangeKinds(registry, base, next), key).not.toEqual([]);
      }
    },
  );
});
