import { describe, expect, it } from "vitest";
import { validateSubscriptionShape, SubscriptionValidationError } from "../subscriptions.js";
import { isPriorityEntry, PRIORITY_EVENT_TYPES } from "../push.js";
import { applyFederationFilter, type FederationFilter } from "../filter.js";
import type { OutboxEntry } from "../outbox.js";

function shape(over: Partial<Parameters<typeof validateSubscriptionShape>[0]> = {}) {
  return {
    filter: {},
    deliveryMode: "pull" as const,
    inboxUrl: null,
    priorityOnly: true,
    ...over,
  };
}

describe("validateSubscriptionShape", () => {
  it("accepts a pull subscription with an empty filter", () => {
    expect(() => validateSubscriptionShape(shape())).not.toThrow();
  });

  it("rejects an unknown delivery mode", () => {
    expect(() =>
      validateSubscriptionShape(shape({ deliveryMode: "carrier-pigeon" as never }))
    ).toThrow(SubscriptionValidationError);
  });

  it("rejects an over-broad webhook filter and recommends a narrower one", () => {
    try {
      validateSubscriptionShape(
        shape({ deliveryMode: "webhook", inboxUrl: "https://peer.example.org/inbox", filter: {} })
      );
      throw new Error("expected a validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(SubscriptionValidationError);
      const e = err as SubscriptionValidationError;
      expect(e.code).toBe("over-broad-filter");
      expect(e.recommended?.types).toBeDefined();
    }
  });

  it("rejects an over-broad sse filter", () => {
    expect(() => validateSubscriptionShape(shape({ deliveryMode: "sse", filter: {} }))).toThrow(
      /bounded filter/
    );
  });

  it("accepts a webhook with a bbox-bounded filter and a public https inbox", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({
          deliveryMode: "webhook",
          inboxUrl: "https://peer.example.org/inbox",
          filter: { bbox: [4, 50, 6, 54] },
        })
      )
    ).not.toThrow();
  });

  it("accepts a types-bounded filter as narrow enough", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({
          deliveryMode: "webhook",
          inboxUrl: "https://peer.example.org/inbox",
          filter: { types: ["road_closure"] },
        })
      )
    ).not.toThrow();
  });

  it("requires an inboxUrl for a webhook", () => {
    try {
      validateSubscriptionShape(
        shape({ deliveryMode: "webhook", inboxUrl: null, filter: { types: ["road_closure"] } })
      );
      throw new Error("expected a validation error");
    } catch (err) {
      expect((err as SubscriptionValidationError).code).toBe("inbox-required");
    }
  });

  it("rejects a non-https inbox", () => {
    try {
      validateSubscriptionShape(
        shape({
          deliveryMode: "webhook",
          inboxUrl: "http://peer.example.org/inbox",
          filter: { types: ["road_closure"] },
        })
      );
      throw new Error("expected a validation error");
    } catch (err) {
      expect((err as SubscriptionValidationError).code).toBe("inbox-not-public");
    }
  });

  it("rejects a loopback/private inbox (SSRF)", () => {
    for (const inboxUrl of [
      "https://127.0.0.1/inbox",
      "https://localhost/inbox",
      "https://10.0.0.5/inbox",
      "https://169.254.169.254/inbox",
    ]) {
      try {
        validateSubscriptionShape(
          shape({ deliveryMode: "webhook", inboxUrl, filter: { types: ["road_closure"] } })
        );
        throw new Error(`expected rejection for ${inboxUrl}`);
      } catch (err) {
        expect((err as SubscriptionValidationError).code, inboxUrl).toBe("inbox-not-public");
      }
    }
  });

  it("SSRF-checks an inbox even in a non-webhook mode when one is supplied", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({ deliveryMode: "pull", inboxUrl: "https://127.0.0.1/inbox" })
      )
    ).toThrow(/public address/);
  });
});

describe("validateSubscriptionShape — filter VALUE validation (all delivery modes)", () => {
  function reject(filter: FederationFilter, mode: "pull" | "webhook" | "sse" = "pull") {
    const over =
      mode === "webhook"
        ? { deliveryMode: mode, inboxUrl: "https://peer.example.org/inbox", filter }
        : { deliveryMode: mode, filter };
    let caught: unknown;
    try {
      validateSubscriptionShape(shape(over));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubscriptionValidationError);
    expect((caught as SubscriptionValidationError).code).toBe("invalid-filter");
  }

  it("rejects a swapped bbox (west >= east)", () => {
    reject({ bbox: [6, 50, 4, 54] });
  });

  it("rejects a swapped bbox (south >= north)", () => {
    reject({ bbox: [4, 54, 6, 50] });
  });

  it("rejects a degenerate bbox (west === east)", () => {
    reject({ bbox: [4, 50, 4, 54] });
  });

  it("rejects a bbox with a NaN / Infinity element", () => {
    reject({ bbox: [4, 50, Number.NaN, 54] });
    reject({ bbox: [4, 50, 6, Number.POSITIVE_INFINITY] });
  });

  it("rejects a bbox with the wrong arity", () => {
    reject({ bbox: [4, 50, 6] as unknown as [number, number, number, number] });
    reject({ bbox: [4, 50, 6, 54, 7] as unknown as [number, number, number, number] });
  });

  it("rejects a bbox out of lon/lat range", () => {
    reject({ bbox: [-181, 50, 6, 54] }); // west < -180
    reject({ bbox: [4, 50, 181, 54] }); // east > 180
    reject({ bbox: [4, -91, 6, 54] }); // south < -90
    reject({ bbox: [4, 50, 6, 91] }); // north > 90
  });

  it("rejects an empty types array", () => {
    reject({ types: [] });
  });

  it("rejects a types array with a blank / non-string entry", () => {
    reject({ types: ["road_closure", "  "] });
    reject({ types: ["road_closure", 5 as unknown as string] });
  });

  it("rejects an empty privacyClasses array and blank entries", () => {
    reject({ privacyClasses: [] });
    reject({ privacyClasses: [""] });
  });

  it("rejects maxAgeSec <= 0 or non-finite", () => {
    reject({ maxAgeSec: 0 });
    reject({ maxAgeSec: -1 });
    reject({ maxAgeSec: Number.NaN });
    reject({ maxAgeSec: Number.POSITIVE_INFINITY });
  });

  it("rejects a non-object filter (a string or array)", () => {
    reject("abc" as unknown as FederationFilter);
    reject([1, 2] as unknown as FederationFilter);
  });

  it("rejects a bad filter for a webhook mode too (all modes are validated)", () => {
    reject({ bbox: [6, 50, 4, 54] }, "webhook");
  });

  it("accepts a fully valid filter across every field", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({
          deliveryMode: "webhook",
          inboxUrl: "https://peer.example.org/inbox",
          filter: {
            bbox: [4, 50, 6, 54],
            types: ["road_closure"],
            privacyClasses: ["authoritative"],
            maxAgeSec: 3600,
          },
        })
      )
    ).not.toThrow();
  });

  it("accepts a bbox at the exact coordinate extremes", () => {
    expect(() =>
      validateSubscriptionShape(shape({ filter: { bbox: [-180, -90, 180, 90] } }))
    ).not.toThrow();
  });

  it("applyFederationFilter is unchanged for a valid filter (golden bbox include/exclude)", () => {
    // A validated filter drives applyFederationFilter identically — validation is
    // a fail-closed gate at subscribe time, not a change to filter evaluation. Use
    // real (non-tombstone) entries so the bbox test actually runs: one geometry
    // INSIDE the bbox is kept, one OUTSIDE is dropped.
    function evt(seq: number, lon: number): OutboxEntry {
      return {
        seq,
        txid: "10",
        operation: "create",
        objectId: `o${seq}`,
        canonicalId: null,
        createdAt: "2026-07-13T00:00:00Z",
        observation: {
          origin: { kind: "feed", attribution: { provider: "A", license: "CC-BY-4.0" } },
          geometry: { type: "Point", coordinates: [lon, 52] },
          dataUpdatedAt: "2026-07-13T11:00:00Z",
          privacyClass: "authoritative",
        } as never,
      };
    }
    const inside = evt(1, 5); // lon 5 ∈ [4, 6]
    const outside = evt(2, 10); // lon 10 ∉ [4, 6]
    const filter: FederationFilter = { bbox: [4, 50, 6, 54], permissiveOnly: false };
    const out = applyFederationFilter([inside, outside], filter, "2026-07-13T12:00:00Z");
    expect(out).toEqual([inside]); // inside kept untouched, outside excluded
  });
});

describe("isPriorityEntry", () => {
  const base: OutboxEntry = {
    seq: 1,
    txid: "10",
    operation: "create",
    objectId: "o1",
    canonicalId: null,
    createdAt: "2026-07-13T00:00:00Z",
  };

  it("keeps a closure/crash event", () => {
    for (const type of PRIORITY_EVENT_TYPES) {
      expect(isPriorityEntry({ ...base, observation: { type } as never })).toBe(true);
    }
  });

  it("drops a non-priority event", () => {
    expect(isPriorityEntry({ ...base, observation: { type: "roadworks" } as never })).toBe(false);
  });

  it("always keeps a delete tombstone (a retraction must propagate)", () => {
    expect(isPriorityEntry({ ...base, operation: "delete", tombstone: true })).toBe(true);
  });
});
