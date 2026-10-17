import { describe, expect, it } from "vitest";
import { assertCovered, coverageGaps } from "../coverage.js";
import {
  definitionEnum,
  jsonSchemaEnums,
  jsonSchemaValidator,
  openApiValidator,
} from "../json-schema.js";
import {
  xsdComplexTypes,
  xsdEnumeration,
  xsdEnumerations,
  xsdErrors,
  xsdSubtypes,
} from "../xsd.js";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
  <xs:simpleType name="StatusEnum">
    <xs:restriction base="xs:string">
      <xs:enumeration value="active"/>
      <xs:enumeration value="suspended"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="Record" abstract="true">
    <xs:sequence><xs:element name="status" type="t:StatusEnum"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Obstruction" abstract="true">
    <xs:complexContent><xs:extension base="t:Record"><xs:sequence/></xs:extension></xs:complexContent>
  </xs:complexType>
  <xs:complexType name="AnimalPresence">
    <xs:complexContent><xs:extension base="t:Obstruction">
      <xs:sequence><xs:element name="alive" type="xs:boolean" minOccurs="0"/></xs:sequence>
    </xs:extension></xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Accident">
    <xs:complexContent><xs:extension base="t:Record"><xs:sequence/></xs:extension></xs:complexContent>
  </xs:complexType>
  <xs:element name="record" type="t:Record"/>
</xs:schema>`;
const SCHEMAS = [{ fileName: "t.xsd", contents: XSD }];

describe("XSD helpers", () => {
  it("reads a named enumeration", () => {
    expect(xsdEnumeration(xsdEnumerations(SCHEMAS), "StatusEnum")).toEqual(["active", "suspended"]);
  });

  it("lists the concrete types derived from a base at any depth", () => {
    const types = xsdComplexTypes(SCHEMAS);
    expect(xsdSubtypes(types, "Record")).toEqual(["Accident", "AnimalPresence"]);
    expect(xsdSubtypes(types, "Record", { abstract: true })).toEqual([
      "Accident",
      "AnimalPresence",
      "Obstruction",
    ]);
    expect(types.get("{urn:t}AnimalPresence")?.elements).toEqual(["alive"]);
  });

  it("validates a document", async () => {
    const ok = `<record xmlns="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Accident"><status>active</status></record>`;
    expect(await xsdErrors(ok, SCHEMAS, "t.xsd")).toEqual([]);
    expect(await xsdErrors(ok.replace(">active<", ">planned<"), SCHEMAS, "t.xsd")).not.toEqual([]);
  });
});

describe("XSD helpers across namespaces", () => {
  const other = XSD.replaceAll("urn:t", "urn:u").replace('value="suspended"', 'value="planned"');
  const both = [...SCHEMAS, { fileName: "u.xsd", contents: other }];

  it("refuses an ambiguous enumeration unless its namespace is named", () => {
    expect(() => xsdEnumeration(xsdEnumerations(both), "StatusEnum")).toThrow(/namespace/);
    expect(xsdEnumeration(xsdEnumerations(both), "StatusEnum", "urn:u")).toEqual([
      "active",
      "planned",
    ]);
  });

  it("follows each namespace's own base types", () => {
    const types = xsdComplexTypes(both);
    expect(xsdSubtypes(types, "{urn:u}Record")).toEqual(["Accident", "AnimalPresence"]);
    expect(types.get("{urn:u}Accident")?.base).toBe("{urn:u}Record");
  });
});

describe("JSON Schema helpers", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
      LaneStatus: { type: "string", enum: ["open", "closed", null] },
      Kind: { oneOf: [{ const: "a" }, { const: "b" }] },
    },
    type: "object",
    properties: { status: { $ref: "#/definitions/LaneStatus" }, when: { format: "date-time" } },
  };

  it("reads enumerations by pointer, constant alternatives included", () => {
    expect(jsonSchemaEnums(schema).get("#/definitions/LaneStatus")).toEqual(["open", "closed"]);
    expect(definitionEnum(schema, "Kind")).toEqual(["a", "b"]);
  });

  it("validates with formats", () => {
    const validate = jsonSchemaValidator(schema);
    expect(validate({ status: "open", when: "2026-10-17T08:00:00Z" })).toEqual([]);
    expect(validate({ status: "shut" })).not.toEqual([]);
    expect(validate({ when: "yesterday" })).not.toEqual([]);
  });

  it("validates an OpenAPI 3.0 component with nullable fields", () => {
    const doc = {
      openapi: "3.0.3",
      components: {
        schemas: {
          Site: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" }, name: { type: "string", nullable: true } },
          },
        },
      },
    };
    const validate = openApiValidator(doc, "Site");
    expect(validate({ id: "1", name: null })).toEqual([]);
    expect(validate({ name: "x" })).not.toEqual([]);
  });
});

describe("coverage", () => {
  it("passes when every value is handled or unsupported with a reason", () => {
    expect(() =>
      assertCovered("status", ["a", "b", "c"], {
        handled: (v) => v !== "c",
        unsupported: { c: "not modelled" },
      }),
    ).not.toThrow();
  });

  it("names unhandled, stale and contradictory values", () => {
    expect(
      coverageGaps(["a", "b", "c"], { handled: ["a", "z"], unsupported: { a: "x", y: "gone" } }),
    ).toEqual({ unhandled: ["b", "c"], stale: ["y"], contradictory: ["a"] });
    expect(() => assertCovered("status", ["a", "b"], { handled: ["a"] })).toThrow(/b/);
  });
});
