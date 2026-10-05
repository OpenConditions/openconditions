import { z } from "zod";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry } from "../registry/build.js";
import {
  defineDomain,
  defineKind,
  defineProperty,
  extendVocabulary,
  type RegistryModule,
} from "../registry/define.js";

/** A registry module with crowd rules and component identities, for tests only. */
export const crowdTestModule: RegistryModule = {
  name: "crowd-test",
  entries: [
    defineDomain({ code: "roads", description: "test roads" }),
    defineDomain({ code: "charging", description: "test charging" }),
    extendVocabulary({ vocabulary: "source_format", values: ["ocpi"] }),
    defineKind({
      class: "situation",
      code: "incident",
      domain: "roads",
      version: "1.0",
      description: "test incident",
      types: { accident: ["overturned"], obstruction: ["animal"] },
      details: () => ({ vehiclesInvolved: z.number().int().nonnegative().optional() }),
      crowd: {
        ttlSec: 1800,
        maxLifetimeSec: 14400,
        types: { obstruction: { ttlSec: 900, maxLifetimeSec: 7200 } },
      },
    }),
    defineKind({
      class: "situation",
      code: "congestion",
      domain: "roads",
      version: "1.0",
      description: "test congestion with a required detail",
      types: { congestion: ["queuing"] },
      details: (k) => ({ los: k.vocab("los") }),
      crowd: { ttlSec: 300, maxLifetimeSec: 3600, matchMetres: 500 },
    }),
    defineKind({
      class: "situation",
      code: "roadworks",
      domain: "roads",
      version: "1.0",
      description: "test works that last weeks",
      types: { works: [] },
      details: () => ({}),
      crowd: { ttlSec: 7 * 86400, maxLifetimeSec: 30 * 86400 },
    }),
    defineKind({
      class: "situation",
      code: "restriction",
      domain: "roads",
      version: "1.0",
      description: "a kind the crowd cannot report",
      types: { dimension: ["height"] },
      details: () => ({}),
    }),
    defineKind({
      class: "component",
      code: "evse",
      version: "1.0",
      description: "test charge point",
      details: () => ({ evseId: z.string().optional() }),
      identity: { idSchemes: ["emi3:evse", "ocpi:evse"] },
    }),
    defineKind({
      class: "component",
      code: "connector",
      version: "1.0",
      description: "test plug",
      details: () => ({ standard: z.string() }),
      identity: { idSchemes: ["ocpi:connector"], withinParent: true },
    }),
    defineKind({
      class: "component",
      code: "fuel_product",
      version: "1.0",
      description: "test product",
      details: () => ({ grade: z.string(), service: z.string().optional() }),
      identity: { fields: ["grade", "service"] },
    }),
    defineKind({
      class: "feature",
      code: "charging_site",
      domain: "charging",
      version: "1.0",
      description: "test site",
      components: ["evse", "connector", "fuel_product"],
      details: () => ({}),
    }),
    defineProperty({
      code: "charging.evse_status",
      domain: "charging",
      version: "1.0",
      description: "test status",
      result: { type: "category", vocabulary: "los" },
      subjects: [{ kind: "feature", componentKinds: ["evse"] }],
      crowd: { ttlSec: 14400, maxLifetimeSec: 172800 },
    }),
    defineProperty({
      code: "fuel.price",
      domain: "charging",
      version: "1.0",
      description: "test price",
      result: { type: "money", per: ["L"] },
      subjects: [{ kind: "feature", componentKinds: ["fuel_product"] }, { kind: "location" }],
      crowd: { ttlSec: 10800, maxLifetimeSec: 43200, agreement: { tolerance: 0.01 } },
    }),
    defineProperty({
      code: "traffic.speed",
      domain: "roads",
      version: "1.0",
      description: "a property the crowd cannot report",
      result: { type: "quantity", unit: "km/h" },
      subjects: [{ kind: "segments" }],
    }),
  ],
};

export const crowdRegistry = buildRegistry([kernelModule, crowdTestModule]);

export const NOW = "2026-10-01T12:00:00Z";
export const KEY = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";

export const crowdAttribution = { provider: "oc.example.org", license: "CC0-1.0" };

export function accidentClaim(overrides: Record<string, unknown> = {}) {
  return {
    claimClass: "situation",
    kind: "incident",
    type: "accident",
    geometry: { type: "Point", coordinates: [8.4037, 49.0069] },
    fuzziness: "exact",
    reportedAt: "2026-10-01T11:58:00Z",
    nonce: "nonce-0000000000000001",
    ...overrides,
  };
}
