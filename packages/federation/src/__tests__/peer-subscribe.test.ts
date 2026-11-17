import { describe, expect, it } from "vitest";
import { generateInstanceKey } from "../keys.js";
import {
  ensurePeerSubscription,
  SUBSCRIPTION_RENEW_BEFORE_SEC,
  type WantedSubscription,
} from "../peer-subscribe.js";
import type { PeerRecord } from "../peers.js";
import type { FederationSubscription } from "../subscriptions.js";

const NOW = "2026-10-01T00:00:00.000Z";
const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();

const PEER: PeerRecord = {
  instanceId: "peer.example.org",
  actorUrl: "https://peer.example.org/.well-known/openconditions/actor.json",
  trustTier: 1,
  pinnedKeys: [],
};

const WANT: WantedSubscription = {
  deliveryMode: "pull",
  filter: { bbox: [4, 50, 6, 54] },
  priorityOnly: false,
  inboxUrl: null,
};

/** The pull subscription the peer holds, matching what is wanted. */
function held(expiresAt: unknown): FederationSubscription {
  return {
    id: "sub-1",
    peerId: "local.example.org",
    filter: WANT.filter,
    deliveryMode: "pull",
    inboxUrl: null,
    cursor: "0.0",
    priorityOnly: false,
    pushFailures: 0,
    revision: 1,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: expiresAt as string,
  };
}

/** A peer that lists `subscription` and accepts a PATCH, recording the methods asked. */
function fakePeer(subscription: FederationSubscription) {
  const asked: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    asked.push(method);
    if (method === "GET") return Response.json({ subscriptions: [subscription] });
    return Response.json({ ...subscription, expiresAt: inDays(30) });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

async function ensure(subscription: FederationSubscription) {
  const peer = fakePeer(subscription);
  const signingKey = await generateInstanceKey(NOW);
  const outcome = await ensurePeerSubscription(PEER, WANT, {
    signingKey,
    fetchImpl: peer.fetchImpl,
    now: NOW,
  });
  return { outcome, asked: peer.asked };
}

describe("ensurePeerSubscription keeps the lease of a matching subscription", () => {
  it("renews well before the lease runs out: half of it", () => {
    expect(SUBSCRIPTION_RENEW_BEFORE_SEC).toBe(15 * 86_400);
  });

  it("leaves one alone while more than 15 days of its lease remain", async () => {
    const { outcome, asked } = await ensure(held(inDays(16)));
    expect(outcome).toEqual({ ok: true, status: "unchanged", id: "sub-1" });
    expect(asked).toEqual(["GET"]);
  });

  it("renews one with 15 days or less to run", async () => {
    for (const days of [15, 3]) {
      const { outcome, asked } = await ensure(held(inDays(days)));
      expect(outcome).toEqual({ ok: true, status: "renewed", id: "sub-1" });
      expect(asked).toEqual(["GET", "PATCH"]);
    }
  });

  it("renews one whose lease the peer does not state, or states unreadably", async () => {
    for (const expiresAt of [undefined, "soon", 42]) {
      const { outcome } = await ensure(held(expiresAt));
      expect(outcome).toMatchObject({ ok: true, status: "renewed" });
    }
  });

  it("still says updated when the subscription differs, renewing it with the patch", async () => {
    const { outcome, asked } = await ensure({ ...held(inDays(3)), priorityOnly: true });
    expect(outcome).toEqual({ ok: true, status: "updated", id: "sub-1" });
    expect(asked).toEqual(["GET", "PATCH"]);
  });
});
