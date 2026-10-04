import { describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { econtrolFeed, fixture, parseContext } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `econtrol-by-address-{die,sup,gas}.json` are the live E-Control
 * Spritpreisrechner answers for the centre of the 0.1° cell 16.3–16.4 E,
 * 48.2–48.3 N (Vienna), one per fuel type, fetched 2026-10-04 01:20Z, with
 * every station's `contact` block removed: it holds what look like private
 * mail addresses. A station the search lists without a price is one whose
 * price the calculator does not show for that fuel type.
 */
const FETCHED = "2026-10-04T01:20:00Z";

type Draft = Record<string, unknown>;

const ANSWERS = ["die", "sup", "gas"].map((t) => fixture(`econtrol-by-address-${t}.json`));

const parse = (payloads: Buffer[] = ANSWERS) =>
  fuelDomain.formats["econtrol"]!.parse(econtrolFeed(), { main: payloads }, parseContext(FETCHED));

const featureId = (id: number) => `oc:feature:at-econtrol-fuel:${id}`;
const station = (features: Draft[], id: number) => features.find((f) => f["id"] === featureId(id));

const prices = (observations: Draft[], id: number) =>
  new Map(
    observations
      .filter(
        (o) =>
          o["property"] === "fuel.price" &&
          (o["subject"] as { featureId: string }).featureId === featureId(id),
      )
      .map((o) => [(o["subject"] as { componentKey: string }).componentKey, o["result"]]),
  );

const components = (feature: Draft | undefined) =>
  (feature?.["components"] as { key: string; details: Draft }[] | undefined) ?? [];

/** The diesel answer with one station's fields replaced. */
function patchedDiesel(id: number, fields: Record<string, unknown>): Buffer {
  const stations = JSON.parse(ANSWERS[0]!.toString("utf8")) as Draft[];
  for (const s of stations) if (s["id"] === id) Object.assign(s, fields);
  return Buffer.from(JSON.stringify(stations));
}

describe("econtrol", () => {
  test("E-Control answers of three fuel types merge into one station per id", () => {
    const { features, observations } = parse();
    const ids = features.map((f) => f["id"]);
    expect(new Set(ids).size).toBe(ids.length);
    // Ten stations answer for diesel and Super 95 alike, seven others for CNG.
    expect(features).toHaveLength(17);
    const turmoel = station(features, 6083);
    expect(components(turmoel).map((c) => c.key)).toEqual(["diesel", "e5"]);
    expect(prices(observations, 6083)).toEqual(
      new Map([
        ["diesel", { type: "money", amount: "2.094", currency: "EUR", per: "L" }],
        ["e5", { type: "money", amount: "1.819", currency: "EUR", per: "L" }],
      ]),
    );
    expect(turmoel!["details"]).toEqual({ kind: "fuel_station", v: 1, productsComplete: false });
    expect(turmoel!["name"]).toEqual([{ lang: "de", text: "Turmöl Quick" }]);
    expect(turmoel!["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [16.3504673, 48.2266238] },
      address: { street: "Währinger Gürtel 116", postalCode: "1090", city: "Wien", country: "AT" },
      admin: { country: "AT" },
    });
    for (const o of observations.filter((r) => r["property"] === "fuel.price")) {
      expect(o["phenomenonTime"]).toEqual({ instant: FETCHED });
    }
  });

  test("E-Control methane is priced per kilogram", () => {
    const { features, observations } = parse();
    const sterngasse = station(features, 334);
    expect(
      components(sterngasse).map((c) => [c.key, c.details["grade"], c.details["per"]]),
    ).toEqual([["cng", "cng", "kg"]]);
    expect(prices(observations, 334).get("cng")).toEqual({
      type: "money",
      amount: "1.799",
      currency: "EUR",
      per: "kg",
    });
  });

  test("a station listed without a price has no product of that fuel type", () => {
    const { features, observations } = parse();
    const shell = station(features, 437497);
    expect(shell).toBeDefined();
    expect(shell!["components"]).toBeUndefined();
    expect(prices(observations, 437497).size).toBe(0);
    // Listed with a diesel price but none for Super 95.
    expect(components(station(features, 4311)).map((c) => c.key)).toEqual(["diesel"]);
  });

  test("the service a station offers sets its products' service", () => {
    const { features } = parse();
    const service = (id: number) => components(station(features, id))[0]!.details["service"];
    // Attended only.
    expect(service(1354905)).toBe("served");
    // Self service only, and an unattended automat.
    expect(service(4311)).toBe("self");
    expect(service(6083)).toBe("self");
    // Neither stated, or both: the price's service is not known.
    expect(service(449481)).toBeUndefined();
    expect(service(1354751)).toBeUndefined();
  });

  test("a station outside its opening hours is still operational", () => {
    // E-Control's `open` says whether the station is open at the moment of
    // the fetch, by its opening hours: it is no closure.
    const { features } = parse([patchedDiesel(6083, { open: false })]);
    expect(station(features, 6083)!["lifecycle"]).toBe("operational");
    expect(station(features, 449481)!["lifecycle"]).toBe("operational");
  });

  test("a station the answers describe differently keeps the first answer's fields", () => {
    const sup = JSON.parse(ANSWERS[1]!.toString("utf8")) as Draft[];
    for (const s of sup) {
      if (s["id"] !== 6083) continue;
      Object.assign(s, {
        name: "Renamed",
        open: false,
        location: { ...(s["location"] as Draft), city: "Graz", latitude: 47.07, longitude: 15.44 },
        offerInformation: { service: true, selfService: false, unattended: false },
      });
    }
    const { features, observations } = parse([
      ANSWERS[0]!,
      Buffer.from(JSON.stringify(sup)),
      ANSWERS[2]!,
    ]);
    const turmoel = station(features, 6083)!;
    expect(turmoel["name"]).toEqual([{ lang: "de", text: "Turmöl Quick" }]);
    expect(turmoel["lifecycle"]).toBe("operational");
    expect(turmoel["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [16.3504673, 48.2266238] },
      address: { city: "Wien" },
    });
    expect(components(turmoel).map((c) => [c.key, c.details["service"]])).toEqual([
      ["diesel", "self"],
      ["e5", "self"],
    ]);
    // The second answer's price is still the station's.
    expect(prices(observations, 6083).get("e5")).toMatchObject({ amount: "1.819" });
  });

  test("the contact block is dropped", () => {
    const contact = {
      telephone: "+43 1 000000",
      fax: "+43 1 000001",
      mail: "jane.doe@example.org",
      website: "https://example.org/",
    };
    const { features, observations } = parse([patchedDiesel(6083, { contact })]);
    const text = JSON.stringify([...features, ...observations]);
    for (const value of Object.values(contact)) expect(text).not.toContain(value);
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });
});
