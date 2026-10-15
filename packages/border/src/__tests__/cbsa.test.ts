import type { RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { cbsaFlow, parseCbsa } from "../formats/cbsa.js";
import { cbsaFeed, fixture, parseContext } from "./helpers/border-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-14T23:38:07Z";
const HEADER =
  "﻿Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;";

const parse = (payload: Buffer | string) =>
  parseCbsa(
    cbsaFeed(),
    { main: [typeof payload === "string" ? Buffer.from(payload) : payload] },
    parseContext(FETCHED),
  );

const live = () => parse(fixture("cbsa-bwt-eng.csv"));

/** The readings of one office, by queue. */
function readings(observations: readonly RecordDraft[], localId: string) {
  return Object.fromEntries(
    observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId.endsWith(`:${localId}`))
      .map((o) => [
        (o["subject"] as { componentKey: string }).componentKey,
        {
          value: (o["result"] as { value: unknown }).value,
          at: (o["phenomenonTime"] as { instant: string }).instant,
        },
      ]),
  );
}

describe("parseCbsa", () => {
  it("seals every office of the live CSV, each placed at its crossing", () => {
    const out = live();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.features).toHaveLength(30);
    expect(out.rejected).toBe(0);
    expect(out.features.find((f) => f["id"] === "oc:feature:ca-cbsa-waits:douglas")).toMatchObject({
      name: [{ lang: "en", text: "Douglas" }],
      location: {
        geometry: { type: "Point", coordinates: [-122.75439, 49.00011] },
        admin: { country: "CA" },
        areaDescription: [{ lang: "en", text: "Surrey, BC/Blaine, WA" }],
      },
      externalIds: [{ scheme: "wikidata", id: "Q24190114" }],
      provenance: { recordId: "Douglas", sourceFormat: "cbsa-bwt" },
      details: {
        countries: ["CA", "US"],
        ports: [{ country: "CA", name: [{ lang: "en", text: "Douglas" }] }],
        modes: ["passenger"],
      },
    });
  });

  it("gives each Canada-bound flow a lane group without a programme, and none to a flow not applicable", () => {
    const stStephen = live().features.find(
      (f) => f["id"] === "oc:feature:ca-cbsa-waits:st-stephen",
    )!;
    expect(stStephen["components"]).toEqual([
      {
        key: "passenger",
        kind: "lane_group",
        details: {
          kind: "lane_group",
          v: 1,
          mode: "passenger",
          direction: { from: "US", to: "CA" },
        },
      },
    ]);
    expect(live().features.map((f) => f["id"])).toContain(
      "oc:feature:ca-cbsa-waits:lacolle-route-221",
    );
  });

  it("reads no delay, a stated wait and a closed queue, dated by the office's zone label", () => {
    const { observations } = live();
    expect(readings(observations, "st-stephen")).toEqual({
      passenger: { value: { v: 1, status: "closed" }, at: "2026-10-14T14:35:00Z" },
    });
    expect(readings(observations, "queenston-lewiston-bridge")["commercial"]).toEqual({
      value: { v: 1, status: "delay", waitMinutes: 12 },
      at: "2026-10-14T23:20:00Z",
    });
    expect(readings(observations, "abbotsford-huntingdon")["commercial"]?.value).toEqual({
      v: 1,
      status: "closed",
    });
    // Saskatchewan keeps CST all year.
    expect(readings(observations, "north-portal")["passenger"]).toEqual({
      value: { v: 1, status: "no_delay" },
      at: "2026-10-14T22:15:00Z",
    });
  });

  it("dates a row without an update time, or one after the fetch, by the fetch", () => {
    const out = parse(
      [
        HEADER,
        "Peace Bridge;; Fort Erie, ON/Buffalo, NY;; ;; 10 minutes;; --;; 1 minute;; --;; ",
        "Rainbow Bridge;; Niagara Falls, ON/Niagara Falls, NY;; 2026-10-14 21:00 EDT;; Not Applicable;; --;; No Delay;; --;; ",
        "Emerson;; Emerson, MB/Pembina, ND;; 2026-10-14 17:51;; No Delay;; --;; No Delay;; --;; ",
      ].join("\r\n"),
    );
    expect(readings(out.observations, "peace-bridge")["passenger"]).toEqual({
      value: { v: 1, status: "delay", waitMinutes: 1 },
      at: FETCHED,
    });
    expect(readings(out.observations, "rainbow-bridge")["passenger"]?.at).toBe(FETCHED);
    // No label: the crossing's zone (Central, daylight time in October).
    expect(readings(out.observations, "emerson")["passenger"]?.at).toBe("2026-10-14T22:51:00Z");
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  it("rejects an office the crossing table lacks, and one with no flow", () => {
    const out = parse(
      [
        HEADER,
        "Coaticook;; Coaticook, QC/Beecher Falls, VT;; 2026-10-14 18:15 EDT;; No Delay;; --;; No Delay;; --;; ",
        "Douglas;; Surrey, BC/Blaine, WA;; 2026-10-14 16:20 PDT;; Not Applicable;; --;; --;; --;; ",
        "Douglas;; Surrey, BC/Blaine, WA;; 2026-10-14 16:20 PDT;; Not Applicable;; --;; 5 minutes;; --;; ",
      ].join("\n"),
    );
    expect(out.features).toHaveLength(1);
    expect(out.rejected).toBe(2);
  });

  it("fails on a CSV without the columns it reads", () => {
    expect(() => parse("Office,Wait\nPeace Bridge,5")).toThrow(/lacks the office/);
  });
});

describe("cbsaFlow", () => {
  it("reads every flow text CBSA writes", () => {
    expect(cbsaFlow("No Delay")).toEqual({ status: "no_delay" });
    expect(cbsaFlow("1 minute")).toEqual({ status: "delay", waitMinutes: 1 });
    expect(cbsaFlow("1 hour 5 minutes")).toEqual({ status: "delay", waitMinutes: 65 });
    expect(cbsaFlow("2 hours")).toEqual({ status: "delay", waitMinutes: 120 });
    expect(cbsaFlow("Closed")).toEqual({ status: "closed" });
    expect(cbsaFlow("Temporarily closed")).toEqual({ status: "closed" });
    expect(cbsaFlow("Missed update")).toEqual({ status: "unknown" });
    expect(cbsaFlow("Not Applicable")).toBeUndefined();
    expect(cbsaFlow("--")).toBeUndefined();
    expect(cbsaFlow("")).toBeUndefined();
    expect(cbsaFlow(undefined)).toBeUndefined();
  });
});
