import { describe, expect, it } from "vitest";
import { kernelModule } from "../kernel/module.js";
import { anyVocab, enumOf } from "../kernel/vocab.js";
import { buildRegistry } from "../registry/build.js";
import { vocabularyCrosswalk } from "../registry/crosswalk-tables.js";

describe("vocabulary resolution", () => {
  it("closes a value list and rejects everything else", () => {
    const schema = enumOf(["a", "b"]);
    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("c").success).toBe(false);
  });

  it("accepts nothing for an empty vocabulary", () => {
    expect(enumOf([]).safeParse("a").success).toBe(false);
  });

  it("builds static types with any non-empty string", () => {
    expect(anyVocab("anything").safeParse("x").success).toBe(true);
    expect(anyVocab("anything").safeParse("").success).toBe(false);
  });
});

describe("vocabularies several domains share", () => {
  const registry = buildRegistry([kernelModule]);

  it("names the amenities every kind of site publishes", () => {
    const amenity = registry.vocabulary("amenity");
    expect(amenity?.extensible).toBe(true);
    expect(amenity?.values).toEqual(expect.arrayContaining(["toilets", "shower", "restaurant"]));
    expect(amenity?.values).toContain("charging_station");
  });

  it("names which way a measured value is moving", () => {
    expect(registry.vocabulary("trend")?.values).toEqual([
      "rising",
      "falling",
      "steady",
      "filling",
      "clearing",
    ]);
  });

  it("lets a domain add a crosswalk to a shared vocabulary without adding values", () => {
    const withMapping = buildRegistry([
      kernelModule,
      {
        name: "test-domain",
        entries: [
          vocabularyCrosswalk(
            "amenity",
            [{ target: "ocpi", table: { RESTAURANT: "restaurant" } }],
            [],
          ),
        ],
      },
    ]);
    expect(withMapping.crosswalk.value("amenity", "ocpi", "RESTAURANT")).toBe("restaurant");
    expect(withMapping.vocabulary("amenity")?.values).toEqual(
      registry.vocabulary("amenity")?.values,
    );
  });
});
