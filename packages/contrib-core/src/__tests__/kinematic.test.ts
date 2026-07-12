import { describe, expect, it } from "vitest";
import { impliedSpeedKmh, isKinematicallyPlausible, type PriorReport } from "../kinematic.js";

function at(lon: number, lat: number, reportedAt: string): PriorReport {
  return { geometry: { type: "Point", coordinates: [lon, lat] }, reportedAt };
}

// Amsterdam → Berlin is ~577 km great-circle.
const AMSTERDAM: [number, number] = [4.9, 52.37];
const BERLIN: [number, number] = [13.405, 52.52];

describe("impliedSpeedKmh", () => {
  it("computes the great-circle speed between two timed reports", () => {
    const prev = at(...AMSTERDAM, "2026-07-12T08:00:00.000Z");
    const next = at(...BERLIN, "2026-07-12T09:00:00.000Z");
    const speed = impliedSpeedKmh(prev, next);
    expect(speed).toBeGreaterThan(550);
    expect(speed).toBeLessThan(600);
  });

  it("returns null when Δt is zero or negative", () => {
    const prev = at(...AMSTERDAM, "2026-07-12T08:00:00.000Z");
    expect(impliedSpeedKmh(prev, at(...BERLIN, "2026-07-12T08:00:00.000Z"))).toBeNull();
    expect(impliedSpeedKmh(prev, at(...BERLIN, "2026-07-12T07:59:00.000Z"))).toBeNull();
  });

  it("returns null for the same point (no movement implies no speed)", () => {
    const prev = at(...AMSTERDAM, "2026-07-12T08:00:00.000Z");
    const next = at(...AMSTERDAM, "2026-07-12T08:01:00.000Z");
    expect(impliedSpeedKmh(prev, next)).toBeNull();
  });

  it("returns null when a timestamp is not a parseable ISO instant", () => {
    const prev = at(...AMSTERDAM, "Fri Jul 10 2026");
    const next = at(...BERLIN, "2026-07-12T08:01:00.000Z");
    expect(impliedSpeedKmh(prev, next)).toBeNull();
  });

  it("uses geometry centroids, so a LineString prior works", () => {
    const prev: PriorReport = {
      geometry: {
        type: "LineString",
        coordinates: [
          [4.89, 52.37],
          [4.91, 52.37],
        ],
      },
      reportedAt: "2026-07-12T08:00:00.000Z",
    };
    const next = at(4.9, 52.38, "2026-07-12T08:05:00.000Z");
    const speed = impliedSpeedKmh(prev, next);
    expect(speed).not.toBeNull();
    expect(speed!).toBeGreaterThan(0);
    expect(speed!).toBeLessThan(50);
  });
});

describe("isKinematicallyPlausible", () => {
  it("flags a teleport (Amsterdam → Berlin in one minute) as implausible", () => {
    const prev = at(...AMSTERDAM, "2026-07-12T08:00:00.000Z");
    const next = at(...BERLIN, "2026-07-12T08:01:00.000Z");
    expect(isKinematicallyPlausible(prev, next)).toBe(false);
  });

  it("accepts a fast but real 300 km/h drive", () => {
    // 5 km in one minute = 300 km/h.
    const prev = at(4.9, 52.0, "2026-07-12T08:00:00.000Z");
    const next = at(4.9, 52.0449, "2026-07-12T08:01:00.000Z");
    expect(isKinematicallyPlausible(prev, next)).toBe(true);
  });

  it("treats an unmeasurable transition (Δt <= 0 or same point) as plausible", () => {
    const prev = at(...AMSTERDAM, "2026-07-12T08:00:00.000Z");
    expect(isKinematicallyPlausible(prev, at(...BERLIN, "2026-07-12T08:00:00.000Z"))).toBe(true);
    expect(isKinematicallyPlausible(prev, at(...AMSTERDAM, "2026-07-12T08:10:00.000Z"))).toBe(true);
  });

  it("honors a custom maxKmh ceiling", () => {
    // 5 km in one minute = 300 km/h.
    const prev = at(4.9, 52.0, "2026-07-12T08:00:00.000Z");
    const next = at(4.9, 52.0449, "2026-07-12T08:01:00.000Z");
    expect(isKinematicallyPlausible(prev, next, 200)).toBe(false);
  });
});
