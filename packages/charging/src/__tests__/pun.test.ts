import { createHash } from "node:crypto";
import { isPublicRecord } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const capture = JSON.parse(fixture("pun-uta.json").toString());
function bundle(shards = [capture]) {
  const bodies = shards.map((s) => Buffer.from(JSON.stringify(s)));
  const manifest = Buffer.from(
    JSON.stringify({
      sources: {
        pun: {
          status: "ok",
          last_run: "2026-11-06T07:08:53Z",
          files: bodies.map((b, i) => ({
            key: `pun/${String(92090 + i).padStart(6, "0")}.json`,
            size: b.length,
            md5: createHash("md5").update(b).digest("hex"),
          })),
        },
      },
    }),
  );
  return [manifest, ...bodies, manifest];
}
const parse = (shards = [capture]) =>
  chargingDomain.formats["pun"]!.parse(
    catalogFeed("it-agid-pun-charging"),
    { main: bundle(shards) },
    parseContext("2026-11-07T12:00:00Z"),
  );
describe("PUN inventory", () => {
  it("seals captured inventory without availability, payments or offers", () => {
    const out = parse();
    expect(out.features).toHaveLength(18);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
    expect(sealFailures(out.features)).toEqual([]);
    expect(
      out.features.find(
        (f) =>
          f["provenance"] &&
          (f["provenance"] as { recordId: string }).recordId === capture.punti[0].id_evse,
      ),
    ).toMatchObject({
      freshness: { fetchedAt: "2026-11-07T12:00:00Z" },
      location: {
        geometry: { coordinates: [8.953974, 39.292731] },
        address: { postalCode: "09068" },
      },
      lifecycle: "unknown",
    });
    expect(out.features[0]).not.toHaveProperty("access.payment");
  });
  it("reconciles exact duplicates and legacy municipality aliases using EVSE identity", () => {
    const out = parse([capture, capture]);
    expect(out.features).toHaveLength(18);
    expect(out.features).toEqual(parse().features);
  });
  it("refuses conflicting IDs and malformed/empty/invalid coordinates", () => {
    const conflict = structuredClone(capture);
    conflict.punti[0].potenza_w = 999;
    expect(() => parse([capture, conflict])).toThrow();
    for (const row of [
      { ...capture.punti[0], lat: 0, lon: 0 },
      { ...capture.punti[0], id_evse: null },
    ])
      expect(() => parse([{ ...capture, punti: [row] }])).toThrow();
    expect(() => parse([{ ...capture, punti: [] }])).toThrow();
  });
  it("keeps one maximum-power representative connector and explicit lifecycle", () => {
    const rows = ["REMOVED", "UNKNOWN", "PLANNED", "AVAILABLE"].map((status, i) => ({
      ...capture.punti[i],
      stato_raw: status,
      n_connettori: 4,
      potenza_w: 50000,
      cap: null,
      open_24h7: false,
      publication_status: "WAITING_VALIDATION_DATA",
    }));
    const out = parse([{ ...capture, punti: rows }]);
    expect(out.features.map((f) => f["lifecycle"]).sort()).toEqual(
      ["unknown", "planned", "unknown", "decommissioned"].sort(),
    );
    for (const feature of out.features) {
      const c = feature["components"] as { kind: string; details: unknown }[];
      expect(c.filter((x) => x.kind === "connector")).toHaveLength(1);
      expect(c.find((x) => x.kind === "connector")?.details).toMatchObject({ maxPowerKw: 50 });
      expect(feature).not.toHaveProperty("openingHours");
    }
  });
});

it("keeps the captured Rome duplicates and excludes unqualified upstream egress", () => {
  const rome = JSON.parse(fixture("pun-rome-excerpt.json").toString());
  const out = parse([rome]);
  expect(out.features).toHaveLength(5);
  expect(sealFailures(out.features)).toEqual([]);
  const record = out.features[0] as unknown as Parameters<typeof isPublicRecord>[0];
  expect(isPublicRecord(record)).toBe(true);
  for (const license of ["NOASSERTION", "CC-BY-NC-4.0"])
    expect(
      isPublicRecord({ ...record, provenance: { ...record.provenance, upstream: [{ license }] } }),
    ).toBe(false);
});
it("refuses mixed generations and preserves absent connector detail without duplication", () => {
  expect(() => parse([capture, { ...capture, _generated_at: "2026-11-06T07:05:00Z" }])).toThrow();
  const out = parse([
    {
      ...capture,
      punti: [
        {
          ...capture.punti[0],
          standard_connettore: null,
          potenza_w: null,
          cap: null,
          tipo_parcheggio: null,
        },
      ],
    },
  ]);
  expect(sealFailures(out.features)).toEqual([]);
  expect(
    ((out.features[0]?.["components"] ?? []) as { kind: string }[]).filter(
      (c) => c.kind === "connector",
    ),
  ).toHaveLength(0);
});

it("preserves unknown representative connector tokens as diagnostics without losing an EVSE", () => {
  const raw = "FUTURE_CONNECTOR";
  const out = parse([
    {
      ...capture,
      punti: capture.punti.map((row: Record<string, unknown>, i: number) =>
        i === 0 ? { ...row, standard_connettore: raw } : row,
      ),
    },
  ]);
  expect(out.features).toHaveLength(18);
  expect(JSON.stringify(out.features)).toContain(raw);
  expect(JSON.stringify(out.features)).toContain("UNKNOWN");
});
