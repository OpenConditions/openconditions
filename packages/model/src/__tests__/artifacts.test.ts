import { describe, expect, it } from "vitest";
import { kernelModule } from "../kernel/module.js";
import {
  enumArrayCheckSql,
  enumCheckSql,
  jsonSchemaArtifacts,
  registryMarkdown,
} from "../registry/artifacts.js";
import { buildRegistry } from "../registry/build.js";
import { registry } from "./fixtures.js";

describe("jsonSchemaArtifacts", () => {
  it("publishes the kernel defs, one file per entry and an index", () => {
    const files = jsonSchemaArtifacts(registry);
    const index = files.get("index.json") as { file: string }[];
    expect(index.map((e) => e.file)).toEqual(
      [...files.keys()].filter((f) => f !== "index.json").sort(),
    );
    expect(files.has("kernel@1.json")).toBe(true);
    expect(files.has("situation/incident@1.json")).toBe(true);
    expect(files.has("observation/traffic.speed@1.json")).toBe(true);
    expect(files.has("effect/closure@1.json")).toBe(true);
    expect(files.has("result/border_wait@1.json")).toBe(true);
    const kernel = files.get("kernel@1.json") as { $defs: Record<string, unknown> };
    expect(Object.keys(kernel.$defs)).toEqual(
      expect.arrayContaining(["LocationRef", "Effect", "Provenance"]),
    );
  });

  it("closes objects and enumerates closed vocabularies", () => {
    const incident = jsonSchemaArtifacts(registry).get("situation/incident@1.json") as Record<
      string,
      unknown
    >;
    const text = JSON.stringify(incident);
    expect(text).toContain('"additionalProperties":false');
    expect(text).toContain('"enum":["accident","breakdown"]');
    expect(text).toContain('"datex2"');
  });

  it("is deterministic", () => {
    expect(JSON.stringify([...jsonSchemaArtifacts(registry)])).toBe(
      JSON.stringify([...jsonSchemaArtifacts(registry)]),
    );
  });

  it("builds for the kernel alone", () => {
    const files = jsonSchemaArtifacts(buildRegistry([kernelModule]));
    expect([...files.keys()]).toContain("selector/features@1.json");
  });
});

describe("CHECK constraint SQL", () => {
  it("quotes identifiers and escapes values", () => {
    expect(enumCheckSql("kind", ["incident", "o'hare"])).toBe(`"kind" IN ('incident', 'o''hare')`);
    expect(enumArrayCheckSql("amenities", ["wifi"])).toBe(`"amenities" <@ ARRAY['wifi']::text[]`);
    expect(enumCheckSql("kind", [])).toBe("false");
    expect(() => enumCheckSql("kind; drop", ["x"])).toThrow();
  });
});

describe("registryMarkdown", () => {
  it("lists vocabularies, kinds, properties and effects", () => {
    const md = registryMarkdown(registry);
    expect(md).toContain("| `source_format` | yes | `crowd`, `derived`, `datex2` |");
    expect(md).toContain(
      "| `incident` | roads | 1.2 | `accident` (multi_vehicle, overturned); `breakdown` |",
    );
    expect(md).toContain("| `traffic.speed` | roads | 1.0 | quantity (km/h) | feature, segments |");
    expect(md).toContain("| `closure` | 1.0 |");
  });
});
