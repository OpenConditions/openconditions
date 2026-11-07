import { expect, test } from "vitest";
import { parkregAcquisitionHash, parseVegvesenParkreg } from "../formats/vegvesen-parkreg.js";
import { catalogFeed, fixture, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const rows = () => JSON.parse(fixture("vegvesen-parkreg.json").toString());
const feed = () => {
  const base = catalogFeed("no-vegvesen-parking");
  return { ...base, parkreg: { qualified: true, acquisitionSha256: parkregAcquisitionHash(base) } };
};
const parse = (records = rows(), map = records) =>
  parseVegvesenParkreg(
    feed(),
    {
      main: [Buffer.from(JSON.stringify(records))],
      inventory: [Buffer.from(JSON.stringify(map.map((r: { id: number }) => ({ id: r.id }))))],
    },
    parseContext("2026-11-07T12:00:00Z"),
  );

test("real reduced inventory seals, keeps stable ids, postcode and subset capacities", () => {
  const out = parse();
  expect(sealFailures(out.features)).toEqual([]);
  expect(out.features).toHaveLength(2);
  expect(out.observations).toEqual([]);
  expect(out.offers).toEqual([]);
  expect(out.features[0]).toMatchObject({
    id: "oc:feature:no-vegvesen-parking:32771",
    type: "on_street",
    details: { capacityTotal: 10 },
  });
  expect(JSON.stringify(out.features[0])).toContain("0178");
  expect(out.features[1]).toMatchObject({
    details: { capacityTotal: 46 },
    components: [{ key: "car:disabled", details: { capacity: 4 } }],
  });
  const changed = rows();
  changed[0].aktivVersjon.versjonsnummer++;
  changed[0].historiskeVersjoner = [changed[0].aktivVersjon];
  expect(parse(changed).features[0]?.["id"]).toBe(out.features[0]?.["id"]);
});

test("future activation and ended versions are not current features", () => {
  for (const patch of [
    { aktiveringstidspunkt: "2027-01-01T00:00:00Z" },
    { sluttidspunkt: "2026-11-07T12:00:00Z" },
  ]) {
    const r = rows();
    Object.assign(r[0].aktivVersjon, patch);
    expect(parse(r).features).toHaveLength(1);
  }
});

test("unknown enums and garages do not invent layouts or access", () => {
  for (const type of ["PARKERINGSHUS"]) {
    const r = rows();
    r[0].aktivVersjon.typeParkeringsomrade = type;
    const site = parse(r).features[0]!;
    expect((site["details"] as Record<string, unknown>)["layout"]).toBeUndefined();
    expect(site["access"]).toBeUndefined();
  }
  for (const type of ["IKKE_VALGT", "NEW", null]) {
    const r = rows();
    r[0].aktivVersjon.typeParkeringsomrade = type;
    expect(() => parse(r)).toThrow(/type/);
  }
  const r = rows();
  r[0].aktivVersjon.innfartsparkering = "JA";
  expect(parse(r).features[0]?.["type"]).toBe("park_and_ride");
});

for (const field of [
  "antallAvgiftsbelagtePlasser",
  "antallAvgiftsfriePlasser",
  "antallLadeplasser",
  "antallForflytningshemmede",
]) {
  test.each([null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER, "3"])(
    `invalid ${field}: %s retains publication`,
    (value) => {
      const r = rows();
      r[0].aktivVersjon[field] = value;
      expect(() => parse(r)).toThrow();
    },
  );
}

test("missing deactivation, invalid dates, geometry and duplicate identities reject the snapshot", () => {
  for (const patch of [
    { deaktivert: undefined },
    { breddegrad: 91 },
    { lengdegrad: "10" },
    { breddegrad: 0, lengdegrad: 0 },
  ]) {
    const r = rows();
    Object.assign(r[0], patch);
    expect(() => parse(r)).toThrow();
  }
  const r = rows();
  r[0].aktivVersjon.aktiveringstidspunkt = "nonsense";
  expect(() => parse(r)).toThrow();
  expect(() => parse([...rows(), rows()[0]])).toThrow();
});

test("partial and unqualified snapshots have no write authority, qualified empty is explicit", () => {
  expect(() => parse(rows().slice(1), rows())).toThrow(/inventory/);
  const unqualified = catalogFeed("no-vegvesen-parking");
  expect(() => parseVegvesenParkreg(unqualified, {}, parseContext("2026-11-07T12:00:00Z"))).toThrow(
    /qualified/,
  );
  expect(parse([], []).featureSnapshotComplete).toBe(true);
});

test("EV and disabled subsets overlap rather than adding spaces, with a per-subset bound", () => {
  const r = rows();
  r[0].aktivVersjon.antallLadeplasser = 8;
  r[0].aktivVersjon.antallForflytningshemmede = 4;
  const out = parse(r);
  expect(sealFailures(out.features)).toEqual([]);
  expect(out.features[0]).toMatchObject({
    details: { capacityTotal: 10 },
    components: [
      { key: "car:disabled", details: { capacity: 4 } },
      { key: "car:ev_charging", details: { capacity: 8 } },
    ],
  });
  r[0].aktivVersjon.antallLadeplasser = 11;
  expect(() => parse(r)).toThrow(/subset/);
});

test("equal-ID organization subsets and substituted national acquisition cannot authorize replacement", () => {
  for (const change of ["&orgnr=998472156", "&extra=1", "&datafelter=kart", "/historikk"]) {
    const scoped = feed();
    for (const endpoint of Object.values(scoped.endpoints)) endpoint.url += change;
    scoped.parkreg.acquisitionSha256 = parkregAcquisitionHash(scoped);
    expect(() =>
      parseVegvesenParkreg(
        scoped,
        {
          main: [Buffer.from(JSON.stringify(rows().slice(0, 1)))],
          inventory: [Buffer.from(JSON.stringify([{ id: rows()[0].id }]))],
        },
        parseContext("2026-11-07T12:00:00Z"),
      ),
    ).toThrow(/national acquisition/);
  }
});

test("qualification is invalidated when a reviewed acquisition budget changes", () => {
  const changed = feed();
  changed.endpoints["main"]!.budget!.maxBytes++;
  expect(() =>
    parseVegvesenParkreg(
      changed,
      { main: [Buffer.from("[]")], inventory: [Buffer.from("[]")] },
      parseContext("2026-11-07T12:00:00Z"),
    ),
  ).toThrow(/national acquisition/);
});
