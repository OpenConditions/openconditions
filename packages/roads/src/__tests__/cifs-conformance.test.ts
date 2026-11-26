import { pinnedOrUnavailable, type SchemaFile, xsdEnumerations } from "@openconditions/conformance";
import { CIFS_SCHEMA, CIFS_V2 } from "@openconditions/conformance/standards/cifs-v2";
import {
  CIFS_DIRECTIONS,
  CIFS_LANE_STATUSES,
  CIFS_ROADSIDES,
  CIFS_TYPES,
  CIFS_XSD_SUBTYPES,
} from "@openconditions/model-roads";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Holds OpenConditions' CIFS vocabulary declarations against the official
 * Google/Waze `cifsv2.xsd` schema pinned by SHA-256.
 */
describe("CIFS v2 schema conformance", () => {
  let schemas: SchemaFile[] | undefined;
  let unavailable: string | undefined;

  beforeAll(async () => {
    const result = await pinnedOrUnavailable(CIFS_V2);
    if ("files" in result) schemas = result.files;
    else unavailable = result.unavailable;
  }, 60_000);

  it("matches every enumeration declared in cifsv2.xsd", () => {
    if (unavailable) {
      console.warn(unavailable);
      return;
    }
    const xsd = schemas!.find((f) => f.fileName === CIFS_SCHEMA)!.contents;
    const enums = xsdEnumerations(schemas!);

    // Inline anonymous simpleTypes under elements in cifsv2.xsd are extracted by
    // regex or xsdEnumerations; check element-scoped enumerations directly from XSD.
    const elementEnum = (elementName: string): string[] => {
      const re = new RegExp(
        `<xs:element\\s+name="${elementName}"[\\s\\S]*?<xs:restriction[^>]*>([\\s\\S]*?)</xs:restriction>`,
      );
      const match = re.exec(xsd);
      expect(match, `element ${elementName} enumeration`).not.toBeNull();
      return [...match![1]!.matchAll(/<xs:enumeration\s+value="([^"]*)"/g)].map((m) => m[1]!);
    };

    expect(enums).toBeDefined();
    expect(elementEnum("type").sort()).toEqual([...CIFS_TYPES].sort());
    expect(
      elementEnum("subtype")
        .filter((v) => v !== "")
        .sort(),
    ).toEqual([...CIFS_XSD_SUBTYPES].sort());
    expect(elementEnum("direction").sort()).toEqual([...CIFS_DIRECTIONS].sort());
    expect(elementEnum("roadside").sort()).toEqual([...CIFS_ROADSIDES].sort());
    expect(elementEnum("status").sort()).toEqual([...CIFS_LANE_STATUSES].sort());
  });
});
