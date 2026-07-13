import { describe, expect, it } from "vitest";
import { validateSubscriptionShape, SubscriptionValidationError } from "../subscriptions.js";
import { isPriorityEntry, PRIORITY_EVENT_TYPES } from "../push.js";
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
