import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, ocpiFixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T00:05:00Z";

function parse(): ParseOutput {
  const out = chargingDomain.formats["digitraffic"]!.parse(
    catalogFeed("fi-digitraffic-charging"),
    {
      main: [ocpiFixture("digitraffic-locations.json")],
      status: [ocpiFixture("digitraffic-statuses.json")],
      tariffs: [ocpiFixture("digitraffic-tariffs.json")],
    },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = { key: string; kind: string; details: Record<string, unknown> };
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];

describe("digitraffic", () => {
  test("Digitraffic: a status from the status role lands on its EVSE", () => {
    const out = parse();
    const tesla = out.features.find(
      (f) =>
        f["id"] ===
        "oc:feature:fi-digitraffic-charging:FI*TSL*1d7c95f5-5924-461e-9d99-ae5396eab63c",
    );
    expect(
      components(tesla)
        .filter((c) => c.kind === "evse")
        .map((c) => c.key),
    ).toEqual(["FI*TSL*E5FTM6L", "FI*TSL*E5FTM6K"]);
    const reading = out.observations.find(
      (o) => (o["subject"] as { componentKey: string }).componentKey === "FI*TSL*E5FTM6L",
    );
    expect(reading).toMatchObject({
      property: "charging.evse_status",
      subject: { featureId: tesla!["id"] },
      result: { value: "available" },
      // As of the operator's own update time.
      phenomenonTime: { instant: "2026-10-05T23:20:37Z" },
    });
    // Every status of the fixture names an EVSE of a location; Wattery's
    // last changed on 2026-09-03, over 30 days back, and is no reading.
    expect(out.observations).toHaveLength(8);
    expect(
      out.observations.map((o) => (o["subject"] as { componentKey: string }).componentKey),
    ).not.toContain("FI*WTY*E13355*1");
    // A connector's tariff ids are the offers of its site's tariffs.
    expect(
      components(tesla).find((c) => c.key === "FI*TSL*E5FTM6L/1")?.details["tariffRefs"],
    ).toEqual([
      "oc:offer:fi-digitraffic-charging:FI*TSL*1d7c95f5-5924-461e-9d99-ae5396eab63c:e81d652e-a5c7-439c-b0ff-e12fb621e0ce",
    ]);
    expect(out.offers.map((o) => o["id"])).toContain(
      "oc:offer:fi-digitraffic-charging:FI*WTY*347:FI_WTY_E13355_1-tariff",
    );
  });

  test("Digitraffic: the statuses alone, through the full parse's index, give the full parse's readings", () => {
    const payloads = {
      main: [ocpiFixture("digitraffic-locations.json")],
      status: [ocpiFixture("digitraffic-statuses.json")],
      tariffs: [ocpiFixture("digitraffic-tariffs.json")],
    };
    const { full, status } = fullAndStatus(
      "digitraffic",
      catalogFeed("fi-digitraffic-charging"),
      payloads,
      parseContext(FETCHED),
    );
    expect(full.observations).toHaveLength(8);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.rejected).toBe(0);
  });
});
