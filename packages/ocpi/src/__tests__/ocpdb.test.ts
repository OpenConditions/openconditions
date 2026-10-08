import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  decodeOcpiList,
  normaliseLocation,
  normaliseTariff,
  ocpdbAssociations,
  ocpdbSources,
} from "../index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("OCPDB locations", () => {
  const locations = decodeOcpiList<unknown>(fixture("ocpdb-locations.json")).map((l) =>
    normaliseLocation(l),
  );

  test("STATIC status, alpha-3 country and the source extras are read", () => {
    const [charging, , register] = locations;
    expect(register).toMatchObject({
      id: "72555",
      source: "bnetza_api",
      original_id: "1002913",
      country: "DEU",
      time_zone: "Europe/Berlin",
    });
    expect(register?.evses.map((e) => e.status)).toEqual(["STATIC", "STATIC"]);
    expect(charging).toMatchObject({ id: "308744", source: "datex2_enbw", country: "DEU" });
    expect(charging?.evses.map((e) => e.status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "AVAILABLE",
      "AVAILABLE",
    ]);
  });

  test("EVSE and connector ids, the eMI3 id and connector tariff references survive", () => {
    const evse = locations[0]?.evses[0];
    expect(evse).toMatchObject({
      uid: "262347503",
      evse_id: "DE*EBW*E914082*1",
    });
    expect(evse?.connectors[0]).toMatchObject({
      standard: "IEC_62196_T2_COMBO",
      format: "CABLE",
      power_type: "DC",
      max_electric_power: 150000,
    });
    expect(evse?.connectors[0]?.tariff_ids).toHaveLength(1);
  });

  test("the coordinates are the numbers the page carries", () => {
    expect(locations[0]?.coordinates).toEqual({ latitude: 48.718544, longitude: 9.611829 });
  });
});

describe("OCPDB tariffs", () => {
  const tariffs = decodeOcpiList<unknown>(fixture("ocpdb-tariffs.json")).map((t) =>
    normaliseTariff(t),
  );

  test("taxes[0].percentage becomes vat and max_duration 0 is unset", () => {
    const night = tariffs.find((t) => t.id === "138586");
    expect(night?.source).toBe("datex2_enbw");
    expect(night?.type).toBe("AD_HOC_PAYMENT");
    expect(night?.elements[0]?.price_components[0]).toEqual({
      type: "ENERGY",
      price: 0.66386555,
      vat: 19,
    });
    expect(night?.elements[1]?.restrictions).toEqual({ min_duration: 1800 });
  });

  test("a free FLAT component keeps price zero", () => {
    const free = tariffs.find((t) => t.id === "138644");
    expect(free?.elements[0]?.price_components[0]).toEqual({ type: "FLAT", price: 0, vat: 19 });
    expect(free?.start_date_time).toBe("2018-07-20T10:23:41+00:00");
  });

  test("the tariff has no country or party, only the aggregator source", () => {
    expect(tariffs[0]?.country_code).toBeUndefined();
    expect(tariffs[0]?.party_id).toBeUndefined();
  });
});

describe("OCPDB associations", () => {
  test("EVSE uids map to the tariff ids published by the tariffs endpoint", () => {
    const map = ocpdbAssociations(fixture("ocpdb-associations.json"));
    expect(map.get("262347503")).toEqual(["138586"]);
    expect(map.get("262347507")).toEqual(["138587"]);
    const tariffIds = new Set(
      decodeOcpiList<{ id: string }>(fixture("ocpdb-tariffs.json")).map((t) => t.id),
    );
    for (const ids of map.values()) {
      for (const id of ids) expect(tariffIds.has(id)).toBe(true);
    }
  });

  test("an EVSE on several associations accumulates tariff ids without repeats", () => {
    const payload = Buffer.from(
      JSON.stringify({
        items: [
          { id: "1", evses: [{ evse_uid: "a" }, { evse_uid: "b" }] },
          { id: "2", evses: [{ evse_uid: "a" }] },
          { id: "2", evses: [{ evse_uid: "a" }] },
        ],
      }),
    );
    expect(ocpdbAssociations(payload).get("a")).toEqual(["1", "2"]);
    expect(ocpdbAssociations(payload).get("b")).toEqual(["1"]);
  });

  test("the association id is the key, with tariff_id used only when it is absent", () => {
    const payload = Buffer.from(
      JSON.stringify({
        items: [{ tariff_id: "9", evses: [{ evse_uid: "a" }] }],
      }),
    );
    expect(ocpdbAssociations(payload).get("a")).toEqual(["9"]);
  });
});

describe("OCPDB sources", () => {
  test("names, licences and contributors are mapped by uid", () => {
    const sources = ocpdbSources(fixture("ocpdb-sources.json"));
    expect([...sources.keys()]).toEqual(["bnetza_api", "datex2_enbw", "opendata_swiss"]);
    expect(sources.get("bnetza_api")).toEqual({ name: "Bundesnetzagentur", license: "CC BY 4.0" });
    expect(sources.get("datex2_enbw")).toEqual({
      name: "EnBW Datex II",
      license: "CC BY 4.0",
      contributor: "EnBW AG",
    });
    expect(sources.get("opendata_swiss")?.license).toBeUndefined();
  });
});
