import { readFileSync } from "node:fs";
import {
  pinnedOrUnavailable,
  type SchemaFile,
  xsdComplexTypes,
  xsdEnumeration,
  xsdEnumerations,
  xsdErrors,
  xsdSubtypes,
} from "@openconditions/conformance";
import {
  DATEX2_DGT_ES,
  DGT_PAYLOAD_SCHEMA,
} from "@openconditions/conformance/standards/datex2-dgt-es";
import {
  D2_LOGICAL_MODEL_SCHEMA,
  DATEX2_V2 as DATEX2_V2_SCHEMAS,
} from "@openconditions/conformance/standards/datex2-v2";
import {
  DATEX2_V3 as DATEX2_V3_SCHEMAS,
  MESSAGE_CONTAINER_SCHEMA,
  PAYLOAD_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3";
import {
  DATEX2_V2,
  DATEX2_V2_INFRASTRUCTURE,
  DATEX2_V3,
  DATEX2_V3_INFRASTRUCTURE,
} from "@openconditions/model-roads";
import { beforeAll, describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { parseDatexMeasuredData } from "../measuredData.js";
import { parseDatexSiteTable } from "../siteTable.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Every DATEX II situation, measured-data and site-table fixture checked
 * against the official schema of its version: v2.0 to v2.3 documents (one
 * namespace, v2.3 backward compatible) against v2.3, v3 documents against
 * v3.7, and DGT's level-C profile against the schemas DGT publishes for it.
 * The vocabularies the parsers map are checked against the same schemas.
 */
const FIXTURES = new URL("./fixtures/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, FIXTURES), "utf8");

type SchemaSet = "v2" | "v3" | "dgt";

/** A publisher's departure from the schema, and what restores it so the rest can be checked. */
interface Deviation {
  reason: string;
  repair: (xml: string) => string;
}

interface FixtureCase {
  path: string;
  set: SchemaSet;
  /** The schema errors of the document as captured; empty for a valid one. */
  errors: readonly string[];
  /** Applied together, they leave a document the schema accepts. */
  deviations?: readonly Deviation[];
  /** Why a document with errors has no deviations to restore. */
  unrepairable?: string;
}

/**
 * The DATEX document a SOAP envelope carries. The envelope is the v2
 * exchange's transport (France DIR, NDW's v2 feeds), not a deviation.
 */
function unwrapSoap(xml: string): string {
  const body = /<([A-Za-z0-9_]+:)?Body\b[^>]*>([\s\S]*)<\/\1?Body>/.exec(xml);
  return body ? body[2]!.trim() : xml;
}

/** An element of the prefix the document's root uses, around `body`. */
const el = (prefix: string, name: string, body: string) =>
  `<${prefix}${name}>${body}</${prefix}${name}>`;
const prefixOf = (xml: string, name: string) =>
  new RegExp(`<(\\w+:)?${name}\\b`).exec(xml)?.[1] ?? "";
const identifier = (p: string) => el(p, "country", "other") + el(p, "nationalIdentifier", "x");

/** Inserts `fragment` right after the opening tag of the first `name` element. */
function afterOpen(xml: string, name: string, fragment: (prefix: string) => string): string {
  return xml.replace(
    new RegExp(`<(\\w+:)?${name}\\b[^>]*>`),
    (open, prefix: string | undefined) => open + fragment(prefix ?? ""),
  );
}

/** Trimmed v2 fixtures keep the payload but drop the mandatory header elements before it. */
const V2_EXCHANGE: Deviation = {
  reason:
    "the mandatory `exchange` (supplierIdentification) is absent: the capture was trimmed to its payload",
  repair: (xml) =>
    afterOpen(xml, "d2LogicalModel", (p) =>
      el(p, "exchange", el(p, "supplierIdentification", identifier(p))),
    ),
};
const V2_PUBLICATION_TIME: Deviation = {
  reason: "the payload's mandatory `publicationTime` is absent: the capture was trimmed",
  repair: (xml) =>
    afterOpen(xml, "payloadPublication", (p) => el(p, "publicationTime", "2026-01-01T00:00:00Z")),
};
const V2_PUBLICATION_CREATOR: Deviation = {
  reason: "the payload's mandatory `publicationCreator` is absent: the capture was trimmed",
  repair: (xml) =>
    xml.replace(
      /<\/(\w+:)?publicationTime>/,
      (close, p: string | undefined) =>
        close + el(p ?? "", "publicationCreator", identifier(p ?? "")),
    ),
};
const V2_HEADER: Deviation = {
  reason: "the payload's mandatory `headerInformation` is absent: the capture was trimmed",
  repair: (xml) =>
    xml.replace(
      /<(\w+:)?(siteMeasurements|measurementSiteTable)\b/,
      (open, p: string | undefined) =>
        el(
          p ?? "",
          "headerInformation",
          el(p ?? "", "confidentiality", "noRestriction") +
            el(p ?? "", "informationStatus", "real"),
        ) + open,
    ),
};

const CASES: readonly FixtureCase[] = [
  {
    path: "dir-fr/situations.xml",
    set: "v2",
    errors: [
      "Element 'd2LogicalModel': No matching global declaration available for the validation root.",
    ],
    deviations: [
      {
        reason:
          "the root `d2LogicalModel` is in no namespace: DIR binds the DATEX namespace only to the `ns2` prefix of its children",
        repair: (xml) =>
          xml
            .replace("<d2LogicalModel ", "<ns2:d2LogicalModel ")
            .replace(/<\/d2LogicalModel>\s*$/, "</ns2:d2LogicalModel>"),
      },
    ],
  },
  {
    path: "autobahn-bab-datex2/measured.xml",
    set: "v2",
    errors: [
      "Element '{http://datex2.eu/schema/2/2_0}payloadPublication': This element is not expected. Expected is ( {http://datex2.eu/schema/2/2_0}exchange ).",
    ],
    deviations: [V2_EXCHANGE, V2_PUBLICATION_TIME, V2_PUBLICATION_CREATOR, V2_HEADER],
  },
  {
    path: "autobahn-bab-datex2/verortung.xml",
    set: "v2",
    errors: [
      "Element '{http://datex2.eu/schema/2/2_0}payloadPublication': This element is not expected. Expected is ( {http://datex2.eu/schema/2/2_0}exchange ).",
    ],
    deviations: [V2_EXCHANGE, V2_PUBLICATION_TIME, V2_PUBLICATION_CREATOR, V2_HEADER],
  },
  {
    path: "ndw-flow/trafficspeed.xml",
    set: "v2",
    errors: [
      "Element '{http://datex2.eu/schema/2/2_0}payloadPublication': This element is not expected. Expected is ( {http://datex2.eu/schema/2/2_0}exchange ).",
    ],
    deviations: [V2_EXCHANGE, V2_PUBLICATION_CREATOR, V2_HEADER],
  },
  {
    path: "ndw-flow/measurement_site_table.xml",
    set: "v2",
    errors: [
      "Element '{http://datex2.eu/schema/2/2_0}payloadPublication': This element is not expected. Expected is ( {http://datex2.eu/schema/2/2_0}exchange ).",
    ],
    deviations: [
      V2_EXCHANGE,
      V2_PUBLICATION_CREATOR,
      V2_HEADER,
      {
        reason:
          "NDW's v2 level-B `linearByCoordinatesExtension` is written in the DATEX namespace, where `linearExtension` admits only `openlrExtendedLinear` and elements of other namespaces",
        repair: (xml) =>
          xml.replace(
            /<linearExtension>[\s\S]*?<\/linearExtension>/g,
            '<linearExtension><nlx:linearByCoordinatesExtension xmlns:nlx="urn:x-ndw-extension"/></linearExtension>',
          ),
      },
      {
        reason:
          "PZH01_MST_NOLOC_00 is an added test record without the mandatory measurementSpecificCharacteristics and measurementSiteLocation",
        repair: (xml) =>
          xml.replace(
            /<measurementSiteRecord id="PZH01_MST_NOLOC_00"[\s\S]*?<\/measurementSiteRecord>/,
            "",
          ),
      },
    ],
  },
  {
    path: "datex-measured-data/measured_data.xml",
    set: "v2",
    errors: [
      "Element 'D2LogicalModel': No matching global declaration available for the validation root.",
    ],
    unrepairable:
      "hand-written, not a capture: no DATEX namespace, a `D2LogicalModel` root, and v1's `basicDataValue` beside v2's `modelBaseVersion`; it stays as the parser's tolerance case",
  },
  { path: "cita-lu/situations.xml", set: "v3", errors: [] },
  { path: "ndw/actueel_beeld.xml", set: "v3", errors: [] },
  { path: "ndw/restrictions-v3.xml", set: "v3", errors: [] },
  { path: "vild/ndw-method2-points.xml", set: "v3", errors: [] },
  { path: "ndw-flow-v3/measurements.xml", set: "v3", errors: [] },
  { path: "ndw-flow-v3/sites.xml", set: "v3", errors: [] },
  { path: "dgt-es/situations.xml", set: "dgt", errors: [] },
  {
    path: "flanders-be/situations.xml",
    set: "v3",
    errors: [
      "Element '{http://datex2.eu/schema/3/d2Payload}payload': The type definition is abstract.",
    ],
    deviations: [
      {
        reason:
          "the `payload` declares no `xsi:type`, although its type is abstract; it is a SituationPublication",
        repair: (xml) =>
          xml.replace(
            '<ns4:payload modelBaseVersion="3"',
            '<ns4:payload xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns2:SituationPublication" lang="nl" modelBaseVersion="3"',
          ),
      },
      {
        reason: "`feedDescription` is empty, where a multilingual string needs `values`",
        repair: (xml) => xml.replace("<feedDescription/>", ""),
      },
      {
        reason:
          "`situation` is written in the d2Payload namespace instead of the situation namespace",
        repair: (xml) =>
          xml
            .replaceAll("<ns4:situation ", "<ns2:situation ")
            .replaceAll("</ns4:situation>", "</ns2:situation>"),
      },
      {
        reason:
          "`alertCDirection` lacks `alertCAffectedDirection`, mandatory in every v3 release (3.3 to 3.7)",
        repair: (xml) =>
          xml.replaceAll(
            "</ns3:alertCDirectionCoded></ns3:alertCDirection>",
            "</ns3:alertCDirectionCoded><ns3:alertCAffectedDirection>unknown</ns3:alertCAffectedDirection></ns3:alertCDirection>",
          ),
      },
    ],
  },
  {
    path: "hc-hr/events.datex3.xml",
    set: "v3",
    errors: [
      "Element '{http://datex2.eu/schema/3/situation}situationRecord': This element is not expected. Expected is ( {http://datex2.eu/schema/3/situation}headerInformation ).",
      "Element '{http://datex2.eu/schema/3/situation}situationRecord': This element is not expected. Expected is ( {http://datex2.eu/schema/3/situation}headerInformation ).",
      "Element '{http://datex2.eu/schema/3/situation}situationRecord': This element is not expected. Expected is ( {http://datex2.eu/schema/3/situation}headerInformation ).",
      "Element '{http://datex2.eu/schema/3/messageContainer}messageContainer': Missing child element(s). Expected is one of ( {http://datex2.eu/schema/3/messageContainer}payload, {http://datex2.eu/schema/3/messageContainer}cisInformation, {http://datex2.eu/schema/3/messageContainer}exchangeInformation ).",
    ],
    // Hand-written from the publisher's layout (the host is geo-restricted):
    // each record lacks v3's mandatory situation headerInformation and
    // probabilityOfOccurrence, and the container its exchangeInformation.
    deviations: [
      {
        reason: "each situation lacks the mandatory `headerInformation`",
        repair: (xml) =>
          xml.replace(
            /(<\/sit:situationVersionTime>)(\s*<sit:situationRecord)/g,
            "$1<sit:headerInformation><com:informationStatus>real</com:informationStatus></sit:headerInformation>$2",
          ),
      },
      {
        reason: "each record lacks the mandatory `probabilityOfOccurrence`",
        repair: (xml) =>
          xml.replace(
            /(<\/sit:situationRecordVersionTime>)(\s*<sit:validity>)/g,
            "$1<sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence>$2",
          ),
      },
      {
        reason:
          "each record is located by v2's `groupOfLocations`, which v3 renamed `locationReference`",
        repair: (xml) =>
          xml
            .replaceAll("<sit:groupOfLocations ", "<sit:locationReference ")
            .replaceAll("</sit:groupOfLocations>", "</sit:locationReference>"),
      },
      {
        reason:
          "`generalPublicComment` follows the location, where v3 places it before `locationReference`",
        repair: (xml) =>
          xml.replace(
            /(<sit:locationReference [\s\S]*?<\/sit:locationReference>)(\s*<sit:generalPublicComment>[\s\S]*?<\/sit:generalPublicComment>)/g,
            "$2$1",
          ),
      },
      {
        reason:
          "the public comment's `comment` is written in the common namespace instead of the situation namespace",
        repair: (xml) =>
          xml.replace(
            /(<sit:generalPublicComment>\s*)<com:comment>([\s\S]*?)<\/com:comment>/g,
            "$1<sit:comment>$2</sit:comment>",
          ),
      },
      {
        reason:
          "the PoorEnvironmentConditions record lacks its mandatory `poorEnvironmentType` (its comment says strong wind)",
        repair: (xml) =>
          xml.replace(
            /(id="HC_REC_3"[\s\S]*?)(\s*<\/sit:situationRecord>)/,
            "$1<sit:poorEnvironmentType>strongWinds</sit:poorEnvironmentType>$2",
          ),
      },
      {
        reason: "the container lacks the mandatory `exchangeInformation`",
        repair: (xml) =>
          xml.replace(
            /<\/mc:payload>/,
            `</mc:payload><mc:exchangeInformation xmlns:ex="http://datex2.eu/schema/3/exchangeInformation" modelBaseVersion="3"><ex:exchangeContext><ex:codedExchangeProtocol>snapshotPull</ex:codedExchangeProtocol><ex:exchangeSpecificationVersion>3</ex:exchangeSpecificationVersion><ex:supplierOrCisRequester><ex:internationalIdentifier><com:country>hr</com:country><com:nationalIdentifier>HC</com:nationalIdentifier></ex:internationalIdentifier></ex:supplierOrCisRequester></ex:exchangeContext><ex:dynamicInformation><ex:exchangeStatus>online</ex:exchangeStatus><ex:messageGenerationTimestamp>2026-07-30T09:00:00Z</ex:messageGenerationTimestamp></ex:dynamicInformation></mc:exchangeInformation>`,
          ),
      },
    ],
  },
];

/** A libxml2 message without its file and line, which the deviation table does not pin. */
const message = (raw: string) => raw.replace(/^.*?Schemas validity error : /, "").trim();

const ROOTS: Record<SchemaSet, (xml: string) => string> = {
  v2: () => D2_LOGICAL_MODEL_SCHEMA,
  v3: (xml) => (/<(\w+:)?messageContainer\b/.test(xml) ? MESSAGE_CONTAINER_SCHEMA : PAYLOAD_SCHEMA),
  dgt: () => DGT_PAYLOAD_SCHEMA,
};

const SOURCE: SourceDescriptor = {
  id: "xx-datex-schema",
  country: "XX",
  attribution: "test",
  license: "CC0-1.0",
};

describe("DATEX II fixtures against the official schemas", () => {
  const schemas = new Map<SchemaSet, SchemaFile[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [set, pinned] of [
      ["v2", DATEX2_V2_SCHEMAS],
      ["v3", DATEX2_V3_SCHEMAS],
      ["dgt", DATEX2_DGT_ES],
    ] as const) {
      const result = await pinnedOrUnavailable(pinned);
      if ("unavailable" in result) {
        unavailable = result.unavailable;
        return;
      }
      schemas.set(set, result.files);
    }
  }, 300_000);

  const errorsOf = async (c: FixtureCase, xml: string) =>
    (await xsdErrors(xml, schemas.get(c.set)!, ROOTS[c.set](xml), c.path)).map(message);

  for (const c of CASES) {
    it(`${c.path} (${c.set}) gives exactly its listed schema errors`, async ({ skip }) => {
      if (unavailable) skip(unavailable);
      const xml = unwrapSoap(read(c.path));
      expect(await errorsOf(c, xml)).toEqual(c.errors);
    }, 300_000);

    if (c.deviations) {
      it(`${c.path} validates once its listed deviations are restored`, async ({ skip }) => {
        if (unavailable) skip(unavailable);
        const repaired = c.deviations!.reduce((xml, d) => d.repair(xml), unwrapSoap(read(c.path)));
        expect(await errorsOf(c, repaired)).toEqual([]);
      }, 300_000);
    }
  }

  it("every fixture with errors explains each by a deviation, or says why none applies", () => {
    for (const c of CASES) {
      if (c.errors.length > 0) {
        expect((c.deviations?.length ?? 0) > 0 || c.unrepairable !== undefined, c.path).toBe(true);
      }
      for (const d of c.deviations ?? []) expect(d.reason.length, c.path).toBeGreaterThan(20);
    }
  });
});

describe("the parsers cope with the publishers' deviations", () => {
  it("France DIR: a root in no namespace still yields its situation records", () => {
    const events = parseDatexSituations(read("dir-fr/situations.xml"), SOURCE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.situation?.classification !== undefined)).toBe(true);
  });

  it("Flanders: an untyped payload and a misplaced situation still yield every record", () => {
    const events = parseDatexSituations(read("flanders-be/situations.xml"), SOURCE);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.situation?.classification !== undefined)).toBe(true);
    // The Alert-C reference is read although its mandatory affected direction is missing.
    expect(events.filter((e) => e.externalRefs?.tmc !== undefined).length).toBeGreaterThan(0);
  });

  it("Croatia: records without probability or situation header are read all the same", () => {
    const events = parseDatexSituations(read("hc-hr/events.datex3.xml"), SOURCE);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.confidence === undefined)).toBe(true);
  });

  it("NDW v2: the level-B linear extension places the site; the record without a location is left out", () => {
    const sites = parseDatexSiteTable(read("ndw-flow/measurement_site_table.xml"));
    expect(sites.get("PZH01_MST_0029-00")?.geometry?.type).toBe("LineString");
    expect(sites.has("PZH01_MST_NOLOC_00")).toBe(false);
  });

  it("trimmed and hand-written measured data still reads", () => {
    const ctx = { now: "2026-07-24T17:12:00Z", cadenceSec: 60 };
    for (const [path, table] of [
      ["autobahn-bab-datex2/measured.xml", "autobahn-bab-datex2/verortung.xml"],
      ["ndw-flow/trafficspeed.xml", "ndw-flow/measurement_site_table.xml"],
      ["datex-measured-data/measured_data.xml", undefined],
    ] as const) {
      const sites = table === undefined ? undefined : parseDatexSiteTable(read(table));
      const { readings, failed } = parseDatexMeasuredData(read(path), SOURCE, sites, ctx);
      expect(failed, path).toBeUndefined();
      expect(readings.length, path).toBeGreaterThan(0);
    }
  });
});

describe("the DATEX vocabularies the parsers map are the schemas' own", () => {
  const schemas = new Map<"v2" | "v3", SchemaFile[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [set, pinned] of [
      ["v2", DATEX2_V2_SCHEMAS],
      ["v3", DATEX2_V3_SCHEMAS],
    ] as const) {
      const result = await pinnedOrUnavailable(pinned);
      if ("unavailable" in result) {
        unavailable = result.unavailable;
        return;
      }
      schemas.set(set, result.files);
    }
  }, 300_000);

  const VERSIONS = [
    {
      label: "v2.3",
      set: "v2" as const,
      situation: DATEX2_V2,
      infrastructure: DATEX2_V2_INFRASTRUCTURE,
      namespace: (_ns: string) => "http://datex2.eu/schema/2/2_0",
    },
    {
      label: "v3.7",
      set: "v3" as const,
      situation: DATEX2_V3,
      infrastructure: DATEX2_V3_INFRASTRUCTURE,
      namespace: (ns: string) => `http://datex2.eu/schema/3/${ns}`,
    },
  ];
  const sorted = (values: Iterable<string>) => [...values].sort();
  /** An enumerated type from the first of the namespaces that declares it. */
  const enumIn = (
    enums: ReturnType<typeof xsdEnumerations>,
    name: string,
    namespaces: string[],
  ) => {
    const ns = namespaces.find((n) => enums.some((e) => e.name === name && e.namespace === n));
    return xsdEnumeration(enums, name, ns);
  };

  it.for(VERSIONS)(
    "$label: record classes are SituationRecord's concrete subtypes, each discriminator its enumeration",
    ({ set, situation, namespace }, { skip }) => {
      if (unavailable) skip(unavailable);
      const files = schemas.get(set)!;
      const enums = xsdEnumerations(files);
      const types = xsdComplexTypes(files);
      expect(sorted(situation.recordClasses)).toEqual(
        xsdSubtypes(types, `{${namespace("situation")}}SituationRecord`),
      );
      for (const [cls, { element, values }] of Object.entries(
        situation.discriminators as Record<string, { element: string; values: readonly string[] }>,
      )) {
        const enumName = `${element.charAt(0).toUpperCase()}${element.slice(1)}Enum`;
        expect(sorted(values), `${cls}.${element}`).toEqual(
          sorted(enumIn(enums, enumName, [namespace("situation"), namespace("common")])),
        );
      }
      expect(sorted(situation.causeTypes)).toEqual(
        sorted(enumIn(enums, "CauseTypeEnum", [namespace("situation"), namespace("common")])),
      );
      expect(sorted(situation.severities)).toEqual(
        sorted(enumIn(enums, "SeverityEnum", [namespace("situation"), namespace("common")])),
      );
      expect(sorted(situation.probabilities)).toEqual(
        sorted(
          enumIn(enums, "ProbabilityOfOccurrenceEnum", [
            namespace("situation"),
            namespace("common"),
          ]),
        ),
      );
      const lists: [readonly string[], string][] = [
        [situation.validityStatuses, "ValidityStatusEnum"],
        [situation.operatorActionStatuses, "OperatorActionStatusEnum"],
        [situation.complianceOptions, "ComplianceOptionEnum"],
        [situation.trafficConstrictionTypes, "TrafficConstrictionTypeEnum"],
        [situation.trafficTypes, "TrafficTypeEnum"],
        [situation.mobilityTypes, set === "v3" ? "MobilityTypeEnum" : "MobilityEnum"],
        [situation.days, "DayEnum"],
        [situation.months, "MonthOfYearEnum"],
        ...("weeksOfMonth" in situation
          ? [[situation.weeksOfMonth, "WeekOfMonthEnum"] as [readonly string[], string]]
          : []),
        [situation.delayBands, "DelayBandEnum"],
        [situation.delaysTypes, "DelaysTypeEnum"],
        [situation.roadworksScales, "RoadworksScaleEnum"],
        [situation.roadworksDurations, "RoadworksDurationEnum"],
        [situation.sourceTypes, "SourceTypeEnum"],
        [situation.directions, "DirectionEnum"],
      ];
      for (const [values, name] of lists) {
        expect(sorted(values), name).toEqual(
          sorted(
            enumIn(enums, name, [
              namespace("situation"),
              namespace("common"),
              namespace("locationReferencing"),
            ]),
          ),
        );
      }
    },
  );

  it.for(VERSIONS)(
    "$label: traffic statuses and measured value types are the schema's",
    ({ set, infrastructure, namespace }, { skip }) => {
      if (unavailable) skip(unavailable);
      const files = schemas.get(set)!;
      const enums = xsdEnumerations(files);
      const types = xsdComplexTypes(files);
      const ns = namespace("roadTrafficData");
      expect(sorted(infrastructure.trafficStatuses)).toEqual(
        sorted(xsdEnumeration(enums, "TrafficStatusEnum", ns)),
      );
      expect(sorted(infrastructure.travelTimeTrendTypes)).toEqual(
        sorted(xsdEnumeration(enums, "TravelTimeTrendTypeEnum", ns)),
      );
      expect(sorted(infrastructure.vmsTypes)).toEqual(
        sorted(xsdEnumeration(enums, "VmsTypeEnum", set === "v3" ? namespace("vms") : ns)),
      );
      // The weather and pollution types (`…Information`) are the weather package's.
      expect(sorted(Object.keys(infrastructure.measuredValues))).toEqual(
        xsdSubtypes(types, `{${ns}}BasicData`).filter((t) => !t.endsWith("Information")),
      );
    },
  );
});
