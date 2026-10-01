import { describe, expect, it } from "vitest";
import {
  admitRecord,
  parseSchemaVersion,
  schemaVersions,
  sharedSchemaMajors,
} from "../registry/versions.js";
import { incidentDraft, registry, stored } from "./fixtures.js";

const local = schemaVersions(registry);
const bump = (versions: string[], key: string, version: string) =>
  versions.map((v) => (v.startsWith(`${key}@`) ? `${key}@${version}` : v));

describe("schema versions", () => {
  it("lists the kernel and every kind, property, effect, selector and result schema", () => {
    expect(local).toContain("kernel@1.0");
    expect(local).toContain("situation/incident@1.2");
    expect(local).toContain("observation/traffic.speed@1.0");
    expect(local).toContain("effect/closure@1.0");
    expect(local).toContain("selector/features@1.0");
    expect(local).toContain("result/border_wait@1.0");
    expect(local).toEqual([...local].sort());
    expect(parseSchemaVersion("situation/incident@1.2")).toEqual({
      key: "situation/incident",
      major: 1,
      minor: 2,
    });
    expect(parseSchemaVersion("incident")).toBeUndefined();
  });

  it("shares what both sides run at one major, and nothing across kernel majors", () => {
    const peer = bump(bump(local, "situation/incident", "1.5"), "observation/traffic.speed", "2.0");
    const shared = sharedSchemaMajors(local, peer);
    expect(shared).toContain("situation/incident@1");
    expect(shared).not.toContain("observation/traffic.speed@1");
    expect(sharedSchemaMajors(local, bump(local, "kernel", "2.0"))).toEqual([]);
  });
});

describe("admitting a peer's record", () => {
  const record = stored(incidentDraft());

  it("admits a record of a schema both run", () => {
    const admitted = admitRecord(registry, local, record);
    expect(admitted).toMatchObject({ admitted: true, stripped: [] });
  });

  it("drops the fields of a newer minor and keeps the rest", () => {
    const newer = bump(local, "situation/incident", "1.3");
    const extended = {
      ...record,
      details: { ...record.details, towTruckEta: "2026-09-18T11:00:00Z" },
      effects: [{ ...record.effects[0], laneHint: "left" }],
    };
    const admitted = admitRecord(registry, newer, extended);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(admitted.stripped).toEqual(["details.towTruckEta", "effects.0.laneHint"]);
    expect(admitted.record["details"]).toEqual(record.details);
  });

  it("rejects unknown fields from a peer that runs no newer minor", () => {
    const admitted = admitRecord(registry, local, {
      ...record,
      details: { ...record.details, towTruckEta: "x" },
    });
    expect(admitted).toMatchObject({
      admitted: false,
      issues: [expect.objectContaining({ code: "unrecognized_keys" })],
    });
  });

  it("rejects a record carrying an effect kind this registry does not know, never dropping it", () => {
    const peer = [...bump(local, "situation/incident", "1.3"), "effect/service_change@1.0"];
    const admitted = admitRecord(registry, peer, {
      ...record,
      effects: [
        ...record.effects,
        { ...record.effects[0], id: "SIT-1/service", kind: "service_change" },
      ],
    });
    expect(admitted).toMatchObject({ admitted: false });
    expect("issues" in admitted && admitted.issues[0]!.path).toEqual(["effects", 1, "kind"]);
  });

  it("rejects a record naming affected things by a selector this registry does not know", () => {
    const peer = [...bump(local, "situation/incident", "1.3"), "selector/vehicles@1.0"];
    const admitted = admitRecord(registry, peer, {
      ...record,
      affects: { vehicles: [{ class: "feature", id: "oc:feature:x:1" }] },
    });
    expect(admitted).toMatchObject({ admitted: false });
    expect("issues" in admitted && admitted.issues[0]!.path).toEqual(["affects"]);
  });

  it("skips what this registry does not run: an unknown kind, another major, another kernel", () => {
    expect(admitRecord(registry, local, { ...record, kind: "volcano" })).toEqual({
      admitted: false,
      skipped: "situation/volcano is not registered here",
    });
    expect(admitRecord(registry, bump(local, "situation/incident", "2.0"), record)).toEqual({
      admitted: false,
      skipped: "the peer does not run situation/incident@1",
    });
    expect(admitRecord(registry, bump(local, "kernel", "2.0"), record)).toEqual({
      admitted: false,
      skipped: "the peer runs another kernel major",
    });
  });
});
