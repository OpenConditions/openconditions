import {
  COMPASS_POINTS,
  defineKind,
  defineProperty,
  defineVocabulary,
  quantityIn,
  SeasonalWindow,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "roads";
const V = "1.0";
const HOUR = 3600;

export const PASS_STATUSES = [
  "open",
  "closed",
  "restricted",
  "chains_required",
  "unknown",
] as const;
/** The chain requirement levels of the Californian scheme, which other winter feeds adopt. */
export const CHAIN_LEVELS = ["none", "R1", "R2", "R3"] as const;

export const passStatusVocabulary = defineVocabulary({
  code: "pass_status",
  values: PASS_STATUSES,
  extensible: false,
  description: "Whether a mountain pass can be driven, and on what condition.",
});
export const chainLevelVocabulary = defineVocabulary({
  code: "chain_level",
  values: CHAIN_LEVELS,
  extensible: false,
  description: "Which vehicles must carry or fit chains (Caltrans R1–R3).",
});

/**
 * Mountain passes and chain-control zones: registers of the stretches that
 * close or need chains in winter. When a source publishes such a register
 * (WSDOT, Caltrans, the Norwegian road database) their current state is an
 * observation on the feature; the `pass_status` and `winter_operation`
 * situations are for sources that publish closures and chain requirements
 * as events.
 */
export const ROADS_WINTER_KINDS = [
  defineKind({
    class: "feature",
    code: "mountain_pass",
    domain: DOMAIN,
    version: V,
    description: "A mountain pass or other weather-exposed stretch that closes in winter.",
    details: (k) => ({
      /** The summit's elevation. */
      elevation: quantityIn("m").optional(),
      /** The steepest official gradient, in percent. */
      gradientPct: z.number().nonnegative().optional(),
      fromName: k.Text.optional(),
      toName: k.Text.optional(),
      /** When the pass is normally closed all day, in a normal year. */
      winterClosure: SeasonalWindow.optional(),
      /** When it normally closes overnight. */
      nightClosure: SeasonalWindow.optional(),
      /** When it is kept open with reduced winter service only. */
      reducedWinterService: SeasonalWindow.optional(),
      /** Days closed in a normal year. */
      closedDaysPerYear: z.number().int().min(0).max(366).optional(),
    }),
    linking: {
      idSchemes: ["osm:way", "osm:relation"],
      alwaysMetres: 500,
      neverMetres: 5000,
      attribute: { name: 0.5 },
      nameStopwords: ["pass", "fjellet", "sattel", "col", "passo", "puerto", "summit"],
      osm: { tags: ["mountain_pass=yes"] },
    },
  }),
  defineKind({
    class: "feature",
    code: "chain_control_zone",
    domain: DOMAIN,
    version: V,
    description:
      "A stretch where chain requirements are imposed, located by the checkpoint that enforces them.",
    details: () => ({}),
  }),
];

const PASS = { kind: "feature", featureKinds: ["mountain_pass"] } as const;

export const ROADS_WINTER_PROPERTIES = [
  defineProperty({
    code: "pass.status",
    domain: DOMAIN,
    version: V,
    description:
      "Whether a pass is open, and on what condition, per direction where the source splits it.",
    result: { type: "category", vocabulary: "pass_status" },
    subjects: [PASS],
    qualifiers: () => ({ direction: z.enum(COMPASS_POINTS).optional() }),
    freshnessWindowSec: 6 * HOUR,
    retention: { changeOnly: true },
    routingRelevant: true,
  }),
  defineProperty({
    code: "winter.chain_level",
    domain: DOMAIN,
    version: V,
    description: "The chain requirement in force.",
    result: { type: "category", vocabulary: "chain_level" },
    subjects: [PASS, { kind: "feature", featureKinds: ["chain_control_zone"] }],
    freshnessWindowSec: 6 * HOUR,
    retention: { changeOnly: true },
    routingRelevant: true,
  }),
];
