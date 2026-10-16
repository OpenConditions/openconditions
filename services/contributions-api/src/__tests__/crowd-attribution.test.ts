import { resolveCrowdCredit } from "@openconditions/ingest-framework";
import { landClaim } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { captureCrowdAttribution } from "../crowd-attribution.js";
import { registry, situationClaim } from "./crowd-fixtures.integration.js";

describe("fresh crowd attribution", () => {
  it.each(["ODbL-1.0", "CC0-1.0"])("lands a fresh report with captured %s licensing", (license) => {
    const credit = resolveCrowdCredit(
      {
        OPENCONDITIONS_CROWD_LICENSE: license,
        OPENCONDITIONS_CROWD_SOURCE_URI: "https://crowd.example/reports",
      },
      "crowd.example",
    );
    const attribution = captureCrowdAttribution(credit);
    const landed = landClaim(
      registry,
      { claim: situationClaim(), keyId: "reporter" },
      { instanceId: "crowd.example", now: "2026-07-12T08:00:00.000Z", attribution },
    );
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.draft.provenance).toMatchObject({
      attribution: {
        provider: "OpenConditions contributors at crowd.example",
        license,
        url: "https://crowd.example/reports",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "OpenConditions contributors at crowd.example",
              license: { kind: "spdx", expression: license },
            },
          ],
        },
      },
    });
  });
});
