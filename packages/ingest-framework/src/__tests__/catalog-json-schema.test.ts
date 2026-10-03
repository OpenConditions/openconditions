import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineIngestDomain } from "../catalog/domain.js";
import { credentialsFileJsonSchema, regionFileJsonSchema } from "../catalog/json-schema.js";
import { LICENSES } from "../catalog/licenses.js";
import { credentialsFileSchema, feedBaseShape } from "../catalog/schema.js";
import { testDomain } from "./helpers/catalog-domain.js";

interface FieldSchema {
  enum?: string[];
  pattern?: string;
}

type JsonSchema = {
  allowTrailingCommas?: boolean;
  properties: {
    feeds: {
      items: {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, FieldSchema> & {
          endpoints: { additionalProperties: { properties: { decoder: FieldSchema } } };
        };
      };
    };
  };
};

describe("catalogue JSON Schemas", () => {
  test("the region JSON Schema is strict and allows trailing commas", () => {
    const schema = regionFileJsonSchema(testDomain) as JsonSchema;
    expect(schema.allowTrailingCommas).toBe(true);
    expect(schema.properties.feeds.items.required).toEqual(
      expect.arrayContaining(["operator", "product", "endpoints"]),
    );
    expect(schema.properties.feeds.items.additionalProperties).toBe(false);
  });

  test("the region JSON Schema lists the domain's products, formats and decoders and the licences", () => {
    const feed = (regionFileJsonSchema(testDomain) as JsonSchema).properties.feeds.items;
    expect(feed.properties["product"]).toMatchObject({
      enum: ["events", "conditions", "flow"],
      pattern: "^[a-z0-9]+$",
    });
    expect(feed.properties["format"]?.enum).toEqual(["datex2"]);
    expect(feed.properties.endpoints.additionalProperties.properties.decoder.enum).toEqual([
      "datex2-sites",
    ]);
    expect(feed.properties["license"]?.enum).toEqual(LICENSES.map((l) => l.id));
    expect(feed.properties["license"]?.enum).toEqual(
      expect.arrayContaining(["CC0-1.0", "NOASSERTION"]),
    );
  });

  test("a domain check with no JSON Schema of its own fails the generation", () => {
    const opaque = defineIngestDomain({
      ...testDomain,
      feedShape: { ...feedBaseShape, odd: z.custom<string>(() => true).optional() },
    });
    expect(() => regionFileJsonSchema(opaque)).toThrow(/cannot be represented/i);
  });

  test("the credentials JSON Schema allows trailing commas", () => {
    expect(credentialsFileJsonSchema()).toEqual({
      ...z.toJSONSchema(credentialsFileSchema, { io: "input" }),
      allowTrailingCommas: true,
    });
  });
});
