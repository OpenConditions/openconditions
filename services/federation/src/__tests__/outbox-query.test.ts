import { RECORD_FILTER_KEYS } from "@openconditions/federation";
import { describe, expect, it } from "vitest";
import { OutboxQueryError, parseOutboxQuery, parseStateQuery } from "../outbox-query.js";
import { filterQuery } from "../puller.js";

describe("parseOutboxQuery", () => {
  it("refuses a parameter it does not know, naming it", () => {
    expect(() => parseOutboxQuery({ kind: "closure" })).toThrow(OutboxQueryError);
    expect(() => parseOutboxQuery({ after: "1.1", publicOnly: "false" })).toThrow(
      /^publicOnly is not a parameter/,
    );
  });

  it("accepts every filter key, the cursor and the page size", () => {
    const parsed = parseOutboxQuery({
      after: "12.3",
      limit: "50",
      bbox: "4,50,6,54",
      classes: "situation,observation",
      kinds: "closure",
      domains: "roads",
      properties: "traffic.los",
      privacyClasses: "authoritative",
      minEvidenceTier: "self_reported",
      maxAgeSec: "3600",
      sourceLiveness: "true",
    });
    expect(Object.keys(parsed.filter ?? {}).sort()).toEqual([...RECORD_FILTER_KEYS].sort());
    expect(parsed.after).toEqual({ txid: "12", seq: 3 });
    expect(parsed.limit).toBe(50);
  });

  it("builds a next link and reads a puller's query from known parameters only", () => {
    const parsed = parseOutboxQuery({ kinds: "closure", limit: "5" });
    const next = Object.fromEntries(new URLSearchParams(parsed.nextParams));
    expect(() => parseOutboxQuery({ ...next, after: "1.1" })).not.toThrow();

    const query = filterQuery({
      bbox: [4, 50, 6, 54],
      classes: ["situation", "observation"],
      kinds: ["closure"],
      domains: ["roads"],
      properties: ["traffic.los"],
      privacyClasses: ["authoritative"],
      minEvidenceTier: "corroborated",
      maxAgeSec: 60,
      sourceLiveness: true,
    });
    query.set("limit", "100");
    query.set("after", "0.0");
    expect(() => parseOutboxQuery(Object.fromEntries(query))).not.toThrow();
  });
});

describe("parseStateQuery", () => {
  it("reads the class, a record id to continue after, a limit and the filter", () => {
    const parsed = parseStateQuery({
      class: "feature",
      after: "oc:feature:nl-ndw-flow:s1",
      limit: "5000",
      kinds: "measurement_site",
    });
    expect(parsed).toEqual({
      cls: "feature",
      after: "oc:feature:nl-ndw-flow:s1",
      limit: 1000,
      filter: { kinds: ["measurement_site"] },
      nextParams: "kinds=measurement_site&limit=1000",
    });
  });

  it("refuses another class, an observation, a long id and an unknown parameter", () => {
    for (const query of [
      {},
      { class: "observation" },
      { class: "camera" },
      { class: "situation", after: "x".repeat(513) },
      { class: "situation", after: "" },
      { class: "situation", limit: "0" },
      { class: "situation", colour: "red" },
    ]) {
      expect(() => parseStateQuery(query), JSON.stringify(query)).toThrow(OutboxQueryError);
    }
  });
});
