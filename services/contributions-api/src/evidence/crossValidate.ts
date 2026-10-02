/**
 * Official cross-validation: the default routing gate driven by
 * authoritative feeds. When a CROWD report agrees with a situation an
 * official feed publishes (`situationsAgree`: the same kind and type, in
 * effect when the report was made, within the kind's match distance), that
 * feed is an EXTERNAL validator — the crowd report is routed via
 * {@link applyExternalResolution} (source "official"), which makes it
 * routing-eligible and trains the reporter's Beta posterior. Peer
 * corroboration ({@link autoCorroborateOnLanding}) stays the primary
 * validator for short-lived events that never reach a feed, and NEVER routes.
 *
 * Trust boundary: only this instance's own feeds cross-validate. A feed
 * record a peer federated carries ≥1 `provenance.originChain` hop; it is a
 * weaker, peer-dependent signal and can never grant local routing
 * eligibility (a peer-echo trust hole otherwise).
 *
 * Federated CROWD target (`deps.allowFederatedTarget`): a peer strips the
 * reporter, so its crowd report is keyless and the STRICT guard skips it.
 * The federation inbox and its sweep opt into routing such a report on a
 * LOCAL feed — a route-without-training in the federated-only case (no key
 * to train), though a local reporter whose report merged into it is still
 * trained, exactly as on any external resolution. The trust anchor stays our
 * own feed, never the peer's word.
 */

import { crowdRulesFor, type Registry, situationsAgree } from "@openconditions/model";
import type postgres from "postgres";
import { actorOf, agreeing, loadSituation, nearbySituations } from "../crowd.js";
import { applyExternalResolution } from "../reputation/resolve.js";

type Sql = postgres.Sql;

/** Injection seam for the routing function (defaults to the real resolution). */
export interface CrossValidateDeps {
  applyExternalResolution?: typeof applyExternalResolution;
  /**
   * Also route a genuinely FEDERATED crowd report (keyless, with a non-empty
   * `originChain`). Defaults false; only the federation inbox and its sweep
   * set it. A keyless crowd report without an origin chain (a local anomaly)
   * is still refused.
   */
  allowFederatedTarget?: boolean;
}

/**
 * Cross-validate the crowd situation `situationId` against every situation
 * this instance's feeds publish nearby. On the FIRST agreeing feed situation,
 * route the crowd report via
 * `applyExternalResolution(..., { source: "official", outcome: "confirmed" })`
 * and return that feed situation's id; null when nothing agrees.
 *
 * Idempotent: `applyExternalResolution`'s insert is NOT-EXISTS-guarded, so a
 * replay appends no second external row and trains no second time.
 */
export async function crossValidateAgainstFeeds(
  sql: Sql,
  registry: Registry,
  situationId: string,
  now: string,
  deps: CrossValidateDeps = {},
): Promise<string | null> {
  const resolve = deps.applyExternalResolution ?? applyExternalResolution;
  const target = await loadSituation(sql, situationId);
  if (target === undefined || target.tombstoneReason !== null || target.flaggedAt !== null) {
    return null;
  }
  const actor = actorOf(target.record);
  if (actor.origin !== "crowd") return null;
  if (actor.keyId === undefined) {
    if (deps.allowFederatedTarget !== true || actor.originChain.length === 0) return null;
  }
  const rules = crowdRulesFor(registry, {
    class: "situation",
    kind: target.kind,
    type: target.type,
  });
  if (rules === undefined) return null;

  const feeds = (
    await nearbySituations(sql, target, rules.matchMetres!, { origins: ["feed"] })
  ).filter((s) => actorOf(s.record).originChain.length === 0);
  const match = feeds.find((feed) => situationsAgree(registry, agreeing(target), agreeing(feed)));
  if (match === undefined) return null;

  await resolve(
    sql,
    registry,
    situationId,
    {
      source: "official",
      outcome: "confirmed",
      matchedRecord: {
        class: "situation",
        id: match.id,
        sourceId: actorOf(match.record).sourceId,
      },
    },
    now,
  );
  return match.id;
}
