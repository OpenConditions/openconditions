import { describe, expect, it } from "vitest";
import { decayMaxLifetimeSec, decayTtlSec, expiresAtFor } from "../index.js";

/**
 * Pins decay.ts's PUBLIC contract: `decay.test.ts` in this directory imports
 * straight from "../decay.js" and exercises full behaviour there. This file
 * only checks that the same names are reachable from the package's barrel
 * entry point ("../index.js") — the path a downstream consumer (crowd
 * reporting's EvidencePolicy construction, federation's TTL-driven
 * minimisation) actually imports from.
 */
describe("decay.ts public contract (packages/roads barrel)", () => {
  it("decayTtlSec, decayMaxLifetimeSec, expiresAtFor are reachable from the public entry", () => {
    expect(decayTtlSec("hazard", "crowd")).toBe(900);
    expect(decayMaxLifetimeSec("hazard")).toBe(7200);
    expect(expiresAtFor("2026-07-11T12:00:00.000Z", "hazard", "crowd")).toBe(
      "2026-07-11T12:15:00.000Z"
    );
  });
});
