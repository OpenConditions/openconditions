import { readFileSync } from "node:fs";
import {
  pinnedOrUnavailable,
  type SchemaFile,
  xsdEnumeration,
  xsdEnumerations,
  xsdErrors,
} from "@openconditions/conformance";
import {
  D2_LOGICAL_MODEL_SCHEMA,
  DATEX2_V2,
} from "@openconditions/conformance/standards/datex2-v2";
import { DATEX2_V3, PAYLOAD_SCHEMA } from "@openconditions/conformance/standards/datex2-v3";
import {
  DATEX2_V3_2,
  PARKING_PAYLOAD_ROOT,
  PARKING_PAYLOAD_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3.2";
import { beforeAll, describe, expect, test } from "vitest";
import {
  parseDatexCameraDevices,
  parseDatexEnergyStatus,
  parseDatexEnergyTable,
  parseDatexParkingStatus,
  parseDatexParkingTable,
  parseXmlDocument,
} from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

type SchemaSet = "v2.3" | "v3.2" | "v3.7";

/** A rewrite made before validation, because of a publisher deviation the rest is checked past. */
interface Rewrite {
  from: RegExp;
  to: string;
  reason: string;
}

/** A deviation the schema reports, matched by the libxml2 message. */
interface Deviation {
  error: RegExp;
  reason: string;
}

interface FixtureCheck {
  file: string;
  schemas: SchemaSet;
  rewrites?: Rewrite[];
  deviations?: Deviation[];
}

/**
 * Every DATEX fixture of this package, against the schema of the version it
 * declares. A deviation is the publisher's, not the decoder's: each one is
 * listed with the reason, and every error the schema reports must be one of
 * them, as every listed one must still be reported.
 */
const FIXTURES: FixtureCheck[] = [
  { file: "ndw-truck-table.xml", schemas: "v2.3" },
  { file: "cita-dynamic.xml", schemas: "v2.3" },
  {
    file: "cita-static.xml",
    schemas: "v2.3",
    rewrites: [
      {
        from: /(<\/?)ns2:d2LogicalModel/g,
        to: "$1d2LogicalModel",
        reason: "the root element is in CITA's own namespace `lu.cita`, not the DATEX one",
      },
    ],
    deviations: [
      {
        error: /groupOfParkingSpaces': The attribute 'groupIndex' is required but missing/,
        reason: "a space group is published without the `groupIndex` its wrapper requires",
      },
      {
        error:
          /parkingNumberOfSpaces': This element is not expected\. Expected is \( \{[^}]+\}parkingSpaceBasics \)/,
        reason:
          "a space group's content sits directly in the wrapper, without the `parkingSpaceBasics` element of type GroupOfParkingSpaces",
      },
      {
        error: /parkingAccess': Duplicate key-sequence \['(MB|TG)'\] in unique identity-constraint/,
        reason:
          "records of opposite directions give their access points the same ids (`MB`, `TG`), which must be unique in the document",
      },
    ],
  },
  {
    file: "ndw-truck-status.xml",
    schemas: "v3.2",
    deviations: [
      {
        error:
          /parkingNumberOfOccupiedSpaces': '-\d+' is not a valid value of the atomic type '\{[^}]+\}NonNegativeInteger'/,
        reason: "NDW publishes negative occupied counts",
      },
    ],
  },
  {
    file: "es-dgt-energy.xml",
    schemas: "v3.7",
    deviations: [
      {
        error: /accessibility': The element is not 'nillable'/,
        reason: "DGT writes an absent accessibility as `xsi:nil`, which the element does not allow",
      },
      {
        error: /accessibility': \[facet 'enumeration'\] The value '' is not an element of the set/,
        reason: "the nil accessibility is an empty value, which AccessibilityEnum does not hold",
      },
    ],
  },
  {
    file: "si-nap-energy.xml",
    schemas: "v3.7",
    rewrites: [
      {
        from: /^<EnergyInfrastructureTablePublication /,
        to: '<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xsi:type="EnergyInfrastructureTablePublication" ',
        reason:
          "the root element is the publication class, where DATEX's only root for it is `d2:payload` with an `xsi:type`",
      },
      {
        from: /<\/EnergyInfrastructureTablePublication>\s*$/,
        to: "</d2:payload>",
        reason: "the root element's end tag",
      },
    ],
    deviations: [
      {
        error: /energyInfrastructureStation': The attribute 'version' is required but missing/,
        reason: "stations are published without the `version` every facility requires",
      },
    ],
  },
  {
    file: "lt-energy-status.xml",
    schemas: "v3.7",
    rewrites: [
      {
        from: /https:\/\/datex2\.eu\/schema\/3\//g,
        to: "http://datex2.eu/schema/3/",
        reason: "the namespaces are written `https://datex2.eu/…`, where DATEX's are `http://`",
      },
    ],
    deviations: [
      {
        error: /feedDescription': Missing child element\(s\)\. Expected is \( \{[^}]+\}values \)/,
        reason: "an empty `feedDescription`, which needs at least one value",
      },
      {
        error:
          /energyInfrastructureSiteStatus', attribute '(id|version)': The attribute '(id|version)' is not allowed/,
        reason: "statuses carry the `id` and `version` of their subject as attributes",
      },
      {
        error: /lastUpdated': This element is not expected\. Expected is \( \{[^}]+\}reference \)/,
        reason: "…instead of the `reference` element every facility status starts with",
      },
    ],
  },
  {
    file: "es-dgt-cameras.xml",
    schemas: "v3.7",
    rewrites: [
      {
        from: /http:\/\/levelC\/schema\/3\//g,
        to: "http://datex2.eu/schema/3/",
        reason:
          "DGT publishes its level C profile with every DATEX namespace renamed `http://levelC/schema/3/…`",
      },
    ],
    deviations: [
      {
        error:
          /device', attribute '[^']+type': The QName value '\{[^}]+faultAndStatusSpanishExtension\}ExtendedDevice' of the xsi:type attribute does not resolve to a type definition/,
        reason:
          "devices are DGT's level C `ExtendedDevice`, a type of its own extension namespace no official schema declares",
      },
      {
        error: /faultAndStatusSpanishExtension\}deviceUrl': This element is not expected/,
        reason: "the image URL is DGT's extension element `deviceUrl`",
      },
      {
        error:
          /(_tpegNonJunctionPointExtension': This element is not expected|point': Missing child element\(s\))\. Expected is \( \{[^}]+\}name \)/,
        reason: "TPEG non-junction points are published without the `name` they require",
      },
      {
        error:
          /typeOfDevice': \[facet 'enumeration'\] The value 'variableMessageSign' is not an element of the set/,
        reason:
          "the hand-made device 9999001 (not DGT data) says `variableMessageSign`, which DeviceTypeEnum spells `vms`",
      },
    ],
  },
];

const ROOTS: Record<SchemaSet, string> = {
  "v2.3": D2_LOGICAL_MODEL_SCHEMA,
  "v3.2": PARKING_PAYLOAD_SCHEMA,
  "v3.7": PAYLOAD_SCHEMA,
};

describe("DATEX fixtures against the official schemas", () => {
  const schemas = new Map<SchemaSet, SchemaFile[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [name, set] of [
      ["v2.3", DATEX2_V2],
      ["v3.2", DATEX2_V3_2],
      ["v3.7", DATEX2_V3],
    ] as const) {
      const pinned = await pinnedOrUnavailable(set);
      if ("unavailable" in pinned) {
        unavailable = pinned.unavailable;
        return;
      }
      schemas.set(name, name === "v3.2" ? [...pinned.files, PARKING_PAYLOAD_ROOT] : pinned.files);
    }
  }, 120_000);

  test.for(FIXTURES)(
    "$file follows $schemas but for its listed deviations",
    {
      timeout: 60_000,
    },
    async (check, { skip }) => {
      if (unavailable) skip(unavailable);
      let xml = fixture(check.file);
      for (const rewrite of check.rewrites ?? []) {
        expect(rewrite.from.test(xml), rewrite.reason).toBe(true);
        rewrite.from.lastIndex = 0;
        xml = xml.replace(rewrite.from, rewrite.to);
      }
      const errors = await xsdErrors(
        xml,
        schemas.get(check.schemas)!,
        ROOTS[check.schemas],
        check.file,
      );
      const deviations = check.deviations ?? [];
      expect(errors.filter((e) => !deviations.some((d) => d.error.test(e)))).toEqual([]);
      expect(
        deviations.filter((d) => !errors.some((e) => d.error.test(e))).map((d) => d.reason),
      ).toEqual([]);
    },
  );

  test("Lithuania's statuses are the refill point statuses in upper case", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const statuses = xsdEnumeration(
      xsdEnumerations(schemas.get("v3.7")!),
      "RefillPointStatusEnum",
      "http://datex2.eu/schema/3/energyInfrastructure",
    );
    const published = [
      ...new Set(
        [...fixture("lt-energy-status.xml").matchAll(/<egi:status>([^<]*)</g)].map((m) => m[1]!),
      ),
    ].sort();
    // Not one value is the enumeration's own spelling, so the schema refuses each.
    expect(published.filter((v) => statuses.includes(v))).toEqual([]);
    expect(published.map((v) => statuses.find((s) => s.toLowerCase() === v.toLowerCase()))).toEqual(
      ["available", "charging", "inoperative", "outOfOrder", "removed", "unknown"],
    );
  });
});

describe("the decoders read past the publishers' deviations", () => {
  test("CITA's space groups without index or basics are read, indexed by position", () => {
    const records = parseDatexParkingTable(parseXmlDocument(fixture("cita-static.xml")));
    expect(records.find((r) => r.id === "G-MB-B")?.groups.slice(0, 2)).toEqual([
      { index: "0", vehicleTypes: ["lorry"], userGroups: [], characterised: true, spaces: 106 },
      { index: "1", vehicleTypes: [], userGroups: [], characterised: true, spaces: 0 },
    ]);
  });

  test("NDW's negative occupied counts are no count", () => {
    const xml = fixture("ndw-truck-status.xml");
    const negative = [...xml.matchAll(/<ns2:parkingNumberOfOccupiedSpaces>-/g)].length;
    expect(negative).toBeGreaterThan(0);
    const statuses = parseDatexParkingStatus(parseXmlDocument(xml));
    const counts = statuses.flatMap((s) => [s.occupied, ...s.groups.map((g) => g.occupied)]);
    expect(counts.every((n) => n === undefined || n >= 0)).toBe(true);
  });

  test("DGT's nil accessibility is not read, and its sites are", () => {
    expect(parseDatexEnergyTable(parseXmlDocument(fixture("es-dgt-energy.xml")))).toHaveLength(3);
  });

  test("Slovenia's root publication and its unversioned stations are read", () => {
    const sites = parseDatexEnergyTable(parseXmlDocument(fixture("si-nap-energy.xml")));
    expect(sites).toHaveLength(3);
    expect(sites.every((s) => s.stations.length > 0)).toBe(true);
  });

  test("Lithuania's https namespaces, id attributes and upper-case statuses are read", () => {
    const statuses = parseDatexEnergyStatus(parseXmlDocument(fixture("lt-energy-status.xml")));
    expect(statuses[0]).toMatchObject({
      refillPointId: "0",
      siteId: "EGI-S-257",
      stationId: "EGI-ST-257",
      connectorIndex: "1",
      status: "removed",
    });
    expect(new Set(statuses.map((s) => s.status))).toEqual(
      new Set(["available", "charging", "inoperative", "outOfOrder", "removed", "unknown"]),
    );
  });

  test("DGT's level C cameras are read; the hand-made sign is no camera", () => {
    const devices = parseDatexCameraDevices(parseXmlDocument(fixture("es-dgt-cameras.xml")));
    expect(devices.map((d) => d.id)).toEqual(["176130", "2", "167979"]);
    expect(devices[0]).toMatchObject({
      imageUrl: "https://etraffic.dgt.es/camarasEtraffic/176130.jpg",
      kilometrePoint: 25.3,
    });
  });
});
