import fc from "fast-check";
import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  draftProblems,
  enumsByProperty,
  fuzzParameters,
  mutateJson,
  mutateXml,
  mutations,
  xmlCharProblems,
} from "../fuzz.js";

const DOC = { items: [{ id: "a", status: "OPEN", n: 3, ok: true, tags: ["x", "y"] }], total: 1 };

describe("mutateJson", () => {
  it("leaves the input alone and keeps to the places it is given", () => {
    const before = JSON.stringify(DOC);
    fc.assert(
      fc.property(mutations({ max: 6 }), (list) => {
        const { doc } = mutateJson(DOC, list, { within: (path) => path[0] === "items" });
        expect(JSON.stringify(DOC)).toBe(before);
        expect((doc as { total: number }).total).toBe(1);
      }),
      fuzzParameters(200),
    );
  });

  it("adds an inherited key as an own property", () => {
    const { doc, applied } = mutateJson(
      DOC,
      [{ at: 1, op: { kind: "inherited-key", key: "__proto__" } }],
      { within: (path) => path.length === 2 },
    );
    expect(applied).toEqual(["items.0: add key __proto__"]);
    const item = (doc as { items: object[] }).items[0]!;
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(JSON.stringify(item)).toContain('"__proto__":"x"');
  });

  it("swaps a value for one its property enumerates", () => {
    const enums = enumsByProperty(
      new Map([["#/components/schemas/Site/properties/status", ["OPEN", "CLOSED"]]]),
    );
    const { doc } = mutateJson(DOC, [{ at: 0, op: { kind: "enum", pick: 1 } }], {
      within: (path) => path.at(-1) === "status",
      enums,
    });
    expect((doc as typeof DOC).items[0]!.status).toBe("CLOSED");
  });
});

describe("mutateXml", () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?><r xmlns="urn:x"><a lang="de">OPEN</a><b>2026-10-20T10:00:00Z</b><c>4.5</c></r>`;

  it("always gives a well-formed document", () => {
    fc.assert(
      fc.property(mutations({ max: 6 }), (list) => {
        const { xml } = mutateXml(XML, list, { enumerations: [["OPEN", "CLOSED"]] });
        expect(XMLValidator.validate(xml)).toBe(true);
        expect(xmlCharProblems(xml)).toEqual([]);
      }),
      fuzzParameters(200),
    );
  });

  it("swaps an enumerated text within its enumeration", () => {
    const { xml } = mutateXml(XML, [{ at: 0, op: { kind: "enum", pick: 1 } }], {
      enumerations: [["OPEN", "CLOSED"]],
    });
    expect(xml).toContain('<a lang="de">CLOSED</a>');
  });
});

describe("draftProblems", () => {
  it("finds functions, non-finite numbers, bad instants and bad geometries", () => {
    const problems = draftProblems([
      {
        id: "x",
        f: Object.prototype.toString,
        n: Number.NaN,
        fetchedAt: "2026-10-20T25:00:00Z",
        geometry: { type: "LineString", coordinates: [[200, 0]] },
      },
    ]);
    expect(problems).toHaveLength(4);
    expect(draftProblems([{ validity: { start: "2026-10-20T10:00:00.5+02:00" } }])).toEqual([]);
  });

  it("holds only the model's time fields to be instants", () => {
    expect(draftProblems([{ name: "2026-10-20T99 road works", end: "soon" }])).toEqual([
      '[0].end: not an instant "soon"',
    ]);
  });

  it("finds characters XML cannot carry", () => {
    expect(xmlCharProblems("<a>\u0001&#x1;&#9;</a>")).toHaveLength(2);
  });
});
