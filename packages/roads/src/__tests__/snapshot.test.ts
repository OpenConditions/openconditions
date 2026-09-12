import { describe, expect, it } from "vitest";
import { parseDatexSnapshot } from "../datex.js";
import { parseDigitrafficSnapshot } from "../digitraffic.js";
import {
  canonicalSnapshotValue,
  type RoadSnapshotRecord,
  reconcileRoadSnapshots,
  snapshotFingerprint,
} from "../snapshot.js";
import { restrictionEvent } from "./fixtures/restriction-event.js";

describe("canonicalSnapshotValue", () => {
  it("is key-order independent and array-order sensitive", () => {
    expect(canonicalSnapshotValue({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalSnapshotValue({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalSnapshotValue([1, 2])).not.toBe(canonicalSnapshotValue([2, 1]));
  });

  it("refuses nonfinite and non-JSON input rather than hashing a lie", () => {
    expect(() => canonicalSnapshotValue({ n: Number.NaN })).toThrow(/nonfinite/);
    expect(() => canonicalSnapshotValue({ when: new Date() })).toThrow(/non-plain/);
    expect(() => canonicalSnapshotValue({ f: () => 1 })).toThrow(/unsupported/);
  });

  it("ignores fetch time so the same record in two partitions collapses", () => {
    const a = restrictionEvent();
    const b = { ...restrictionEvent(), fetchedAt: "2026-09-12T08:00:00.000Z" };
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
  });

  it("changes when a restriction fact changes", () => {
    const changed = restrictionEvent();
    changed.restrictionDetails!.facts[0]!.value = 30000;
    expect(snapshotFingerprint(changed)).not.toBe(snapshotFingerprint(restrictionEvent()));
  });
});

describe("reconcileRoadSnapshots", () => {
  it("preserves two distinct IDs and chooses the newest version independent of order", () => {
    const base = restrictionEvent();
    const a: RoadSnapshotRecord = {
      id: base.id,
      version: 1,
      versionTime: null,
      fingerprint: "old",
      disposition: "accepted",
      event: base,
    };
    const b = {
      ...a,
      version: 2,
      fingerprint: "new",
      event: { ...base, headline: "Updated" },
    };
    const c = {
      ...a,
      id: "fi-digitraffic:another",
      event: { ...base, id: "fi-digitraffic:another" },
    };
    for (const records of [
      [a, b, c],
      [c, b, a],
    ]) {
      const out = reconcileRoadSnapshots([{ inputCount: 3, records, errors: [] }]);
      expect(out.uniqueCount).toBe(2);
      expect(out.observations.find((e) => e.id === base.id)?.headline).toBe("Updated");
    }
    expect(() =>
      reconcileRoadSnapshots([
        { inputCount: 2, records: [a, { ...a, fingerprint: "conflict" }], errors: [] },
      ]),
    ).toThrow(/conflict/);
  });

  it("reconciles across partitions independent of partition order", () => {
    const base = restrictionEvent();
    const older: RoadSnapshotRecord = {
      id: base.id,
      version: 3,
      versionTime: "2026-09-11T10:00:00Z",
      fingerprint: "v3",
      disposition: "accepted",
      event: base,
    };
    const newer: RoadSnapshotRecord = {
      ...older,
      version: 4,
      versionTime: "2026-09-12T10:00:00Z",
      fingerprint: "v4",
      event: { ...base, headline: "Newer" },
    };
    const forward = reconcileRoadSnapshots([
      { inputCount: 1, records: [older], errors: [] },
      { inputCount: 1, records: [newer], errors: [] },
    ]);
    const reverse = reconcileRoadSnapshots([
      { inputCount: 1, records: [newer], errors: [] },
      { inputCount: 1, records: [older], errors: [] },
    ]);
    expect(forward).toEqual(reverse);
    expect(forward.observations[0]?.headline).toBe("Newer");
    expect(forward.inputCount).toBe(2);
    expect(forward.uniqueCount).toBe(1);
    expect(forward.duplicates).toBe(1);
  });

  it("breaks an equal or absent numeric version by a later valid version timestamp", () => {
    const base = restrictionEvent();
    const first: RoadSnapshotRecord = {
      id: base.id,
      version: null,
      versionTime: "2026-09-11T10:00:00Z",
      fingerprint: "a",
      disposition: "accepted",
      event: base,
    };
    const second: RoadSnapshotRecord = {
      ...first,
      versionTime: "2026-09-12T10:00:00Z",
      fingerprint: "b",
      event: { ...base, headline: "Later" },
    };
    const out = reconcileRoadSnapshots([{ inputCount: 2, records: [second, first], errors: [] }]);
    expect(out.observations[0]?.headline).toBe("Later");
  });

  it("collapses an identical duplicate served by two partitions", () => {
    const base = restrictionEvent();
    const record: RoadSnapshotRecord = {
      id: base.id,
      version: 31,
      versionTime: "2026-09-12T07:00:00Z",
      fingerprint: snapshotFingerprint(base),
      disposition: "accepted",
      event: base,
    };
    const out = reconcileRoadSnapshots([
      { inputCount: 1, records: [record], errors: [] },
      { inputCount: 1, records: [{ ...record }], errors: [] },
    ]);
    expect(out.uniqueCount).toBe(1);
    expect(out.duplicates).toBe(1);
    expect(out.observations).toHaveLength(1);
  });

  it("prefers a terminal disposition over an identical accepted duplicate", () => {
    const base = restrictionEvent();
    const accepted: RoadSnapshotRecord = {
      id: base.id,
      version: 5,
      versionTime: null,
      fingerprint: "same",
      disposition: "accepted",
      event: base,
    };
    const out = reconcileRoadSnapshots([
      { inputCount: 2, records: [accepted, { ...accepted, disposition: "terminal" }], errors: [] },
    ]);
    expect(out.terminalIds).toEqual([base.id]);
    expect(out.acceptedIds).toEqual([]);
    expect(out.observations).toEqual([]);
  });

  it("gives every record exactly one disposition", () => {
    const base = restrictionEvent();
    const out = reconcileRoadSnapshots([
      {
        inputCount: 3,
        records: [
          {
            id: "s:a",
            version: 1,
            versionTime: null,
            fingerprint: "a",
            disposition: "accepted",
            event: { ...base, id: "s:a" },
          },
          { id: "s:b", version: 1, versionTime: null, fingerprint: "b", disposition: "terminal" },
          {
            id: "s:c",
            version: 1,
            versionTime: null,
            fingerprint: "c",
            disposition: "unlocatable",
          },
        ],
        errors: [],
      },
    ]);
    expect(out.acceptedIds).toEqual(["s:a"]);
    expect(out.terminalIds).toEqual(["s:b"]);
    expect(out.unlocatableIds).toEqual(["s:c"]);
    expect(out.acceptedIds.length + out.terminalIds.length + out.unlocatableIds.length).toBe(
      out.uniqueCount,
    );
  });

  it("rejects an unaccounted record, a report error and a missing identity", () => {
    const base = restrictionEvent();
    const record: RoadSnapshotRecord = {
      id: base.id,
      version: 1,
      versionTime: null,
      fingerprint: "a",
      disposition: "accepted",
      event: base,
    };
    expect(() =>
      reconcileRoadSnapshots([{ inputCount: 2, records: [record], errors: [] }]),
    ).toThrow(/accounting mismatch/);
    expect(() =>
      reconcileRoadSnapshots([
        {
          inputCount: 1,
          records: [],
          errors: [{ code: "missing_identity", id: null, sourcePath: "features[0]" }],
        },
      ]),
    ).toThrow(/missing_identity/);
    expect(() =>
      reconcileRoadSnapshots([{ inputCount: 1, records: [{ ...record, id: "" }], errors: [] }]),
    ).toThrow(/stable source identity/);
    expect(() =>
      reconcileRoadSnapshots([
        { inputCount: 1, records: [{ ...record, version: 1.5 }], errors: [] },
      ]),
    ).toThrow(/invalid source version/);
    expect(() =>
      reconcileRoadSnapshots([
        { inputCount: 1, records: [{ ...record, versionTime: "not a time" }], errors: [] },
      ]),
    ).toThrow(/invalid source version timestamp/);
  });

  it("accepts a complete empty snapshot without inventing records", () => {
    expect(reconcileRoadSnapshots([{ inputCount: 0, records: [], errors: [] }])).toEqual({
      inputCount: 0,
      uniqueCount: 0,
      duplicates: 0,
      observations: [],
      acceptedIds: [],
      terminalIds: [],
      unlocatableIds: [],
    });
  });
});

const src = {
  id: "fi-digitraffic",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as unknown as Parameters<typeof parseDigitrafficSnapshot>[1];

function feature(
  props: Record<string, unknown>,
  geometry: unknown = {
    type: "Point",
    coordinates: [24.9, 60.2],
  },
): Record<string, unknown> {
  return { type: "Feature", geometry, properties: props };
}

describe("parseDigitrafficSnapshot", () => {
  it("accounts for every input feature exactly once", () => {
    const report = parseDigitrafficSnapshot(
      {
        type: "FeatureCollection",
        features: [
          feature({ situationId: "A", situationType: "road work", version: 1 }),
          feature({ situationId: "B", situationType: "road work", version: 1 }, null),
          feature({
            situationId: "C",
            situationType: "road work",
            version: 1,
            earlyClosing: "canceled",
          }),
        ],
      },
      src,
      { fetchedAt: "2026-09-12T07:14:00.000Z" },
    );
    expect(report.inputCount).toBe(3);
    expect(report.records).toHaveLength(3);
    expect(report.errors).toEqual([]);
    expect(report.records.map((r) => r.disposition)).toEqual([
      "accepted",
      "unlocatable",
      "terminal",
    ]);
    const reconciled = reconcileRoadSnapshots([report]);
    expect(reconciled.acceptedIds).toEqual(["fi-digitraffic:A"]);
    expect(reconciled.unlocatableIds).toEqual(["fi-digitraffic:B"]);
    expect(reconciled.terminalIds).toEqual(["fi-digitraffic:C"]);
  });

  it("reports a record with no stable identity instead of numbering it", () => {
    const report = parseDigitrafficSnapshot(
      { type: "FeatureCollection", features: [feature({ situationType: "road work" })] },
      src,
    );
    expect(report.errors).toEqual([
      { code: "missing_identity", id: null, sourcePath: "features[0]" },
    ]);
    expect(() => reconcileRoadSnapshots([report])).toThrow(/missing_identity/);
  });

  it("reports an invalid envelope, a missing records path and an invalid version", () => {
    expect(parseDigitrafficSnapshot("{not json", src).errors[0]?.code).toBe("invalid_envelope");
    expect(parseDigitrafficSnapshot({ type: "FeatureCollection" }, src).errors[0]?.code).toBe(
      "missing_records_path",
    );
    expect(
      parseDigitrafficSnapshot(
        {
          type: "FeatureCollection",
          features: [feature({ situationId: "A", version: "many" })],
        },
        src,
      ).errors[0]?.code,
    ).toBe("invalid_version");
    expect(
      parseDigitrafficSnapshot(
        {
          type: "FeatureCollection",
          features: [feature({ situationId: "A", versionTime: "yesterday" })],
        },
        src,
      ).errors[0]?.code,
    ).toBe("invalid_version_time");
  });

  it("accepts a valid complete empty collection", () => {
    const report = parseDigitrafficSnapshot({ type: "FeatureCollection", features: [] }, src);
    expect(report).toEqual({ inputCount: 0, records: [], errors: [] });
    expect(reconcileRoadSnapshots([report]).uniqueCount).toBe(0);
  });

  it("keeps two co-located distinct situations apart", () => {
    const at = { type: "Point", coordinates: [24.9, 60.2] };
    const report = parseDigitrafficSnapshot(
      {
        type: "FeatureCollection",
        features: [
          feature({ situationId: "A", situationType: "road work", version: 1 }, at),
          feature({ situationId: "B", situationType: "road work", version: 1 }, at),
        ],
      },
      src,
    );
    expect(reconcileRoadSnapshots([report]).observations.map((o) => o.id)).toEqual([
      "fi-digitraffic:A",
      "fi-digitraffic:B",
    ]);
  });
});

describe("parseDatexSnapshot", () => {
  const datexSrc = {
    id: "nl-ndw",
    attribution: "NDW",
    country: "NL",
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  } as unknown as Parameters<typeof parseDatexSnapshot>[1];

  it("reports an unreadable envelope rather than a successful empty parse", () => {
    const report = parseDatexSnapshot("<not-datex/>", datexSrc);
    expect(report.records).toEqual([]);
    expect(report.inputCount).toBe(0);
  });
});
