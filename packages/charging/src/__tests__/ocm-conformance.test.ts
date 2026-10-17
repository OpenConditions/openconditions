import { assertCovered, parseYaml, pinnedOrUnavailable } from "@openconditions/conformance";
import { OCM } from "@openconditions/conformance/standards/ocm";
import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * Open Charge Map held to its pinned reference data and API description:
 * every connection, current, status, usage and submission status type the
 * reference data lists is read as its title says, or listed with the reason
 * it is not; every field of a POI's address and connection is read or listed
 * as unread.
 */

type Json = Record<string, unknown>;
type Reference = { ID: number; Title: string } & Json;

const FEED_ID = "ocm-charging";
const FETCHED = "2026-10-17T08:00:00Z";

const poi = (over: Json = {}, connection: Json = {}, address: Json = {}): Json => ({
  ID: 1,
  AddressInfo: {
    Title: "Test",
    AddressLine1: "Main Street 1",
    Town: "Town",
    Postcode: "1000",
    Country: { ISOCode: "LU" },
    Latitude: 49.6,
    Longitude: 6.1,
    ...address,
  },
  StatusType: { ID: 50, IsOperational: true },
  UsageType: { ID: 1 },
  SubmissionStatus: { ID: 200, IsLive: true },
  Connections: [{ ID: 10, ConnectionTypeID: 25, CurrentTypeID: 20, PowerKW: 22, ...connection }],
  ...over,
});

function parse(pois: Json[]): ParseOutput {
  const out = chargingDomain.formats["ocm"]!.parse(
    catalogFeed(FEED_ID),
    { main: [Buffer.from(JSON.stringify(pois))] },
    parseContext(FETCHED, 86400),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}
const site = (out: ParseOutput) => out.features[0] as RecordDraft | undefined;
const components = (out: ParseOutput) =>
  (site(out)?.["components"] ?? []) as { kind: string; lifecycle?: string; details: Json }[];
const connector = (out: ParseOutput) => components(out).find((c) => c.kind === "connector");
const noneUnread = () => drainSkipped(FEED_ID)["unknown_value"] === undefined;

/** What each connection type is, by its title and formal name, as an OCPI standard. */
const CONNECTIONS: Readonly<Record<number, string>> = {
  0: "UNKNOWN",
  1: "IEC_62196_T1",
  2: "CHADEMO",
  3: "DOMESTIC_G",
  // The IEC 60309 sockets, 16 A in the probe: 3 pins single-phase, 5 pins three-phase.
  4: "IEC_60309_2_single_16",
  16: "IEC_60309_2_single_16",
  34: "IEC_60309_2_single_16",
  17: "IEC_60309_2_three_16",
  35: "IEC_60309_2_three_16",
  8: "TESLA_R",
  9: "NEMA_5_20",
  10: "NEMA_14_30",
  11: "NEMA_14_50",
  13: "DOMESTIC_C",
  22: "DOMESTIC_B",
  23: "DOMESTIC_E",
  25: "IEC_62196_T2",
  26: "IEC_62196_T3C",
  27: "SAE_J3400",
  28: "DOMESTIC_F",
  29: "DOMESTIC_I",
  30: "TESLA_S",
  32: "IEC_62196_T1_COMBO",
  33: "IEC_62196_T2_COMBO",
  36: "IEC_62196_T3A",
  1036: "IEC_62196_T2",
  1037: "DOMESTIC_J",
  1038: "GBT_AC",
  1039: "GBT_AC",
  1040: "GBT_DC",
  1043: "DOMESTIC_M",
  1044: "CHAOJI",
};

const NO_OCPI = "a plug OCPI's connector types do not name; a connector of unknown standard";

const STATUSES: Readonly<Record<number, string | undefined>> = {
  0: "unknown",
  10: "operational",
  20: "operational",
  // Operational in Open Charge Map's own flag, but unavailable for now.
  30: "temporarily_closed",
  50: "operational",
  75: "operational",
  100: "temporarily_closed",
  150: "planned",
  200: "decommissioned",
};

const USAGES: Readonly<Record<number, string>> = {
  1: "public",
  2: "private",
  3: "restricted",
  4: "public",
  5: "public",
  6: "customers",
  7: "public",
};

const CURRENTS: Readonly<Record<number, string>> = {
  10: "AC_1_PHASE",
  20: "AC_3_PHASE",
  30: "DC",
};

/** Address fields read, each with a value that changes what is published. */
const ADDRESS_READ: Readonly<Record<string, unknown>> = {
  AddressLine1: "Other Street 2",
  AddressLine2: "Level 2",
  Town: "Other",
  StateOrProvince: "Esch",
  Postcode: "2000",
  Country: { ISOCode: "BE" },
  Latitude: 49.7,
  Longitude: 6.2,
  ContactTelephone1: "+352 1",
  ContactTelephone2: "+352 2",
  AccessComments: "Behind the barrier",
  RelatedURL: "https://example.org/site",
  Title: "Other title",
};
const ADDRESS_UNREAD: Readonly<Record<string, [unknown, string]>> = {
  ID: [99, "Open Charge Map's own id of the address record"],
  CountryID: [21, "the country is read from its ISO code"],
  Distance: [3.2, "the distance from a query point, no property of the site"],
  DistanceUnit: [2, "the unit of that distance"],
  ContactEmail: [
    "site@example.org",
    "the site's contact address; the model holds e-mail addresses of organisations only",
  ],
};

const CONNECTION_READ: Readonly<Record<string, unknown>> = {
  ID: 11,
  ConnectionTypeID: 33,
  ConnectionType: { ID: 33, FormalName: "IEC 62196-3 Configuration FF" },
  Reference: "Bay 7",
  StatusTypeID: 30,
  StatusType: { ID: 30, IsOperational: true },
  Amps: 32,
  Voltage: 400,
  PowerKW: 11,
  CurrentTypeID: 30,
  CurrentType: { ID: 30 },
  Quantity: 2,
};
const CONNECTION_UNREAD: Readonly<Record<string, [unknown, string]>> = {
  LevelID: [3, "Open Charge Map's charging level, which the power and current already say"],
  Level: [{ ID: 3 }, "as LevelID"],
  Comments: ["Slow", "free text about the connection, which the model holds no place for"],
};

describe("Open Charge Map through the parser", () => {
  let reference: Record<string, Reference[]> = {};
  let schemas: Record<string, { properties: Json }> = {};
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(OCM);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else {
      const file = (name: string) => pinned.files.find((f) => f.fileName === name)!.contents;
      reference = JSON.parse(file("referencedata.json"));
      schemas = (parseYaml(file("ocm-openapi-spec.yaml")) as { components: { schemas: never } })
        .components.schemas;
    }
  }, 120_000);

  beforeEach(() => {
    __resetSkips();
  });

  const ids = (list: string) => (reference[list] ?? []).map((r) => String(r.ID));

  test("connection types", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("ConnectionTypes", ids("ConnectionTypes"), {
      handled: (v) => {
        const read = connector(parse([poi({}, { ConnectionTypeID: Number(v), Amps: 16 })]));
        const expected = CONNECTIONS[Number(v)];
        return noneUnread() && expected !== undefined && read?.details["standard"] === expected;
      },
      unsupported: Object.fromEntries(
        (reference["ConnectionTypes"] ?? [])
          .filter((r) => CONNECTIONS[r.ID] === undefined)
          .map((r) => [String(r.ID), `${r.Title}: ${NO_OCPI}`]),
      ),
    });
  });

  test("status types", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("StatusTypes", ids("StatusTypes"), {
      handled: (v) => {
        const out = parse([poi({ StatusType: { ID: Number(v) } })]);
        return (
          noneUnread() &&
          STATUSES[Number(v)] !== undefined &&
          site(out)?.["lifecycle"] === STATUSES[Number(v)]
        );
      },
      unsupported: {
        210: "a duplicate listing is left out: the listing it duplicates is the site",
      },
    });
  });

  test("usage types", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("UsageTypes", ids("UsageTypes"), {
      handled: (v) => {
        const usage = (reference["UsageTypes"] ?? []).find((r) => String(r.ID) === v);
        const access = (site(parse([poi({ UsageType: usage })]))?.["access"] ?? {}) as Json;
        return (
          noneUnread() &&
          USAGES[Number(v)] !== undefined &&
          access["audience"] === USAGES[Number(v)]
        );
      },
      unsupported: { 0: "Open Charge Map's unknown: says nothing" },
    });
  });

  test("current types", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("CurrentTypes", ids("CurrentTypes"), {
      handled: (v) =>
        noneUnread() &&
        connector(parse([poi({}, { CurrentTypeID: Number(v) })]))?.details["powerType"] ===
          CURRENTS[Number(v)],
    });
  });

  test("submission status types: only a live listing is a site", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const types = reference["SubmissionStatusTypes"] ?? [];
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      const out = parse([poi({ SubmissionStatus: type })]);
      expect([type.ID, out.features.length]).toEqual([type.ID, type["IsLive"] === true ? 1 : 0]);
    }
  });

  test("every field of an address and a connection is read or listed as unread", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const published = (out: ParseOutput) => JSON.stringify(out.features);
    for (const [schema, read, unread, probe] of [
      ["AddressInfo", ADDRESS_READ, ADDRESS_UNREAD, (v: Json) => poi({}, {}, v)],
      ["ConnectionInfo", CONNECTION_READ, CONNECTION_UNREAD, (v: Json) => poi({}, v)],
    ] as const) {
      const fields = Object.keys(schemas[schema]!.properties);
      expect([...Object.keys(read), ...Object.keys(unread)].sort()).toEqual([...fields].sort());
      const base = published(parse([probe({})]));
      for (const [name, value] of Object.entries(read)) {
        expect([schema, name, published(parse([probe({ [name]: value })])) !== base]).toEqual([
          schema,
          name,
          true,
        ]);
      }
      for (const [name, [value]] of Object.entries(unread)) {
        expect([schema, name, published(parse([probe({ [name]: value })])) === base]).toEqual([
          schema,
          name,
          true,
        ]);
      }
    }
  });
});
