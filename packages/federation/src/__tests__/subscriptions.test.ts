import { describe, expect, it } from "vitest";
import type { RecordFilter } from "../record-filter.js";
import {
  filterIsBounded,
  SubscriptionValidationError,
  validateSubscriptionShape,
} from "../subscriptions.js";

const INBOX = "https://peer.example.org/inbox";

function shape(over: Partial<Parameters<typeof validateSubscriptionShape>[0]> = {}) {
  return {
    filter: {},
    deliveryMode: "pull" as const,
    inboxUrl: null,
    priorityOnly: true,
    ...over,
  };
}

function caught(fn: () => void): SubscriptionValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SubscriptionValidationError);
    return err as SubscriptionValidationError;
  }
  throw new Error("expected a validation error");
}

describe("validateSubscriptionShape", () => {
  it("accepts a pull subscription with an empty filter", () => {
    expect(() => validateSubscriptionShape(shape())).not.toThrow();
  });

  it("rejects an unknown delivery mode", () => {
    expect(
      caught(() => validateSubscriptionShape(shape({ deliveryMode: "carrier-pigeon" as never })))
        .code,
    ).toBe("invalid-delivery-mode");
  });

  it("rejects an over-broad webhook filter and recommends closures and incidents", () => {
    const e = caught(() =>
      validateSubscriptionShape(shape({ deliveryMode: "webhook", inboxUrl: INBOX, filter: {} })),
    );
    expect(e.code).toBe("over-broad-filter");
    expect(e.recommended).toEqual({ kinds: ["closure", "incident"] });
  });

  it("keeps the subscriber's own fields in the recommendation", () => {
    const e = caught(() =>
      validateSubscriptionShape(
        shape({
          deliveryMode: "sse",
          filter: { classes: ["situation"], minEvidenceTier: "self_reported" },
        }),
      ),
    );
    expect(e.code).toBe("over-broad-filter");
    expect(e.recommended).toEqual({
      classes: ["situation"],
      minEvidenceTier: "self_reported",
      kinds: ["closure", "incident"],
    });
  });

  it("rejects an over-broad sse filter", () => {
    expect(() => validateSubscriptionShape(shape({ deliveryMode: "sse", filter: {} }))).toThrow(
      /bounded filter/,
    );
  });

  it("does not count naming only classes as bounded for a push channel", () => {
    expect(
      caught(() =>
        validateSubscriptionShape(
          shape({ deliveryMode: "sse", filter: { classes: ["situation"] } }),
        ),
      ).code,
    ).toBe("over-broad-filter");
  });

  it("accepts a webhook with a bbox-bounded filter and a public https inbox", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({ deliveryMode: "webhook", inboxUrl: INBOX, filter: { bbox: [4, 50, 6, 54] } }),
      ),
    ).not.toThrow();
  });

  it("accepts each allow-list as narrow enough for a push channel", () => {
    const bounded: RecordFilter[] = [
      { kinds: ["closure"] },
      { domains: ["road"] },
      { classes: ["observation"], properties: ["speed"] },
      { privacyClasses: ["authoritative"] },
      { maxAgeSec: 600 },
    ];
    for (const filter of bounded) {
      expect(
        () => validateSubscriptionShape(shape({ deliveryMode: "sse", filter })),
        JSON.stringify(filter),
      ).not.toThrow();
    }
  });

  it("requires an inboxUrl for a webhook", () => {
    expect(
      caught(() =>
        validateSubscriptionShape(
          shape({ deliveryMode: "webhook", inboxUrl: null, filter: { kinds: ["closure"] } }),
        ),
      ).code,
    ).toBe("inbox-required");
  });

  it("rejects a non-https inbox", () => {
    expect(
      caught(() =>
        validateSubscriptionShape(
          shape({
            deliveryMode: "webhook",
            inboxUrl: "http://peer.example.org/inbox",
            filter: { kinds: ["closure"] },
          }),
        ),
      ).code,
    ).toBe("inbox-not-public");
  });

  it("rejects a loopback/private inbox (SSRF)", () => {
    for (const inboxUrl of [
      "https://127.0.0.1/inbox",
      "https://localhost/inbox",
      "https://10.0.0.5/inbox",
      "https://169.254.169.254/inbox",
    ]) {
      const e = caught(() =>
        validateSubscriptionShape(
          shape({ deliveryMode: "webhook", inboxUrl, filter: { kinds: ["closure"] } }),
        ),
      );
      expect(e.code, inboxUrl).toBe("inbox-not-public");
    }
  });

  it("SSRF-checks an inbox even in a non-webhook mode when one is supplied", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({ deliveryMode: "pull", inboxUrl: "https://127.0.0.1/inbox" }),
      ),
    ).toThrow(/public address/);
  });
});

describe("validateSubscriptionShape: filter values (all delivery modes)", () => {
  function reject(filter: RecordFilter, mode: "pull" | "webhook" | "sse" = "pull"): string {
    const over =
      mode === "webhook"
        ? { deliveryMode: mode, inboxUrl: INBOX, filter }
        : { deliveryMode: mode, filter };
    const e = caught(() => validateSubscriptionShape(shape(over)));
    expect(e.code).toBe("invalid-filter");
    return e.message;
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
    reject({ bbox: [-181, 50, 6, 54] });
    reject({ bbox: [4, 50, 181, 54] });
    reject({ bbox: [4, -91, 6, 54] });
    reject({ bbox: [4, 50, 6, 91] });
  });

  it("rejects an empty or blank allow-list for kinds, domains, properties and privacyClasses", () => {
    for (const field of ["kinds", "domains", "properties", "privacyClasses"] as const) {
      expect(reject({ [field]: [] })).toContain(`filter.${field}`);
      expect(reject({ [field]: ["closure", "  "] })).toContain(`filter.${field}`);
      expect(reject({ [field]: ["closure", 5 as unknown as string] })).toContain(`filter.${field}`);
      expect(reject({ [field]: "closure" as unknown as string[] })).toContain(`filter.${field}`);
    }
  });

  it("rejects an empty classes list and a class the model does not have", () => {
    expect(reject({ classes: [] })).toContain("filter.classes");
    expect(reject({ classes: ["situation", "event" as never] })).toMatch(/record classes.*event/);
  });

  it("refuses observations without named properties", () => {
    expect(reject({ classes: ["observation"] })).toMatch(/properties/);
    expect(reject({ classes: ["situation", "observation"], kinds: ["closure"] })).toMatch(
      /properties/,
    );
    expect(() =>
      validateSubscriptionShape(
        shape({ filter: { classes: ["observation"], properties: ["speed", "travel_time"] } }),
      ),
    ).not.toThrow();
  });

  it("accepts every record class by name", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({
          filter: {
            classes: ["feature", "situation", "offer", "observation"],
            properties: ["speed"],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects maxAgeSec <= 0 or non-finite", () => {
    reject({ maxAgeSec: 0 });
    reject({ maxAgeSec: -1 });
    reject({ maxAgeSec: Number.NaN });
    reject({ maxAgeSec: Number.POSITIVE_INFINITY });
  });

  it("rejects a non-object filter (a string, array or null)", () => {
    reject("abc" as unknown as RecordFilter);
    reject([1, 2] as unknown as RecordFilter);
    reject(null as unknown as RecordFilter);
  });

  it("rejects a bad filter for a webhook mode too (all modes are validated)", () => {
    reject({ bbox: [6, 50, 4, 54] }, "webhook");
  });

  it("accepts a fully valid filter across every field", () => {
    expect(() =>
      validateSubscriptionShape(
        shape({
          deliveryMode: "webhook",
          inboxUrl: INBOX,
          filter: {
            bbox: [4, 50, 6, 54],
            classes: ["situation", "observation"],
            kinds: ["closure"],
            domains: ["road"],
            properties: ["speed"],
            privacyClasses: ["authoritative"],
            minEvidenceTier: "self_reported",
            maxAgeSec: 3600,
          },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a bbox at the exact coordinate extremes", () => {
    expect(() =>
      validateSubscriptionShape(shape({ filter: { bbox: [-180, -90, 180, 90] } })),
    ).not.toThrow();
  });
});

describe("filterIsBounded", () => {
  it("is false for an empty filter and for one that only names classes or relaxes gates", () => {
    expect(filterIsBounded({})).toBe(false);
    expect(filterIsBounded({ classes: ["situation", "feature"] })).toBe(false);
    expect(filterIsBounded({ minEvidenceTier: "self_reported" })).toBe(false);
  });

  it("is true for each source-side bound", () => {
    const bounds: RecordFilter[] = [
      { bbox: [4, 50, 6, 54] },
      { kinds: ["closure"] },
      { domains: ["road"] },
      { properties: ["speed"] },
      { privacyClasses: ["authoritative"] },
      { maxAgeSec: 60 },
    ];
    for (const filter of bounds) expect(filterIsBounded(filter), JSON.stringify(filter)).toBe(true);
  });
});
