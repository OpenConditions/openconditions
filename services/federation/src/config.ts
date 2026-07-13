/**
 * Operator configuration for the federation service. Federation is OPT-IN
 * and off by default: without OPENCONDITIONS_FEDERATION_ENABLED the service
 * serves 404 on the well-known routes and never creates an instance key.
 * When enabled, an invalid or missing actor/peers config fails the boot
 * closed rather than serving a half-formed identity.
 */
import { readFileSync } from "node:fs";
import {
  loadPeers,
  parseActorConfig,
  type ActorConfig,
  type PeerRecord,
} from "@openconditions/federation";

export interface FederationSettings {
  enabled: boolean;
  /** Present iff enabled. */
  actor?: ActorConfig;
  /** This instance's declared peers (public metadata; empty by default). */
  peers: PeerRecord[];
}

/** Accepts inline JSON (leading '{' or '[') or a path to a JSON file. */
function readJsonSource(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return readFileSync(trimmed, "utf8");
}

export function resolveFederationSettings(
  env: Record<string, string | undefined>
): FederationSettings {
  const enabledFlag = env["OPENCONDITIONS_FEDERATION_ENABLED"];
  const enabled = enabledFlag === "true" || enabledFlag === "1";
  if (!enabled) return { enabled: false, peers: [] };

  const actorSource = env["OPENCONDITIONS_FEDERATION_ACTOR"];
  if (actorSource === undefined || actorSource.length === 0) {
    throw new Error(
      "federation is enabled but OPENCONDITIONS_FEDERATION_ACTOR is missing " +
        "(inline actor-config JSON or a path to a JSON file)"
    );
  }
  const actor = parseActorConfig(readJsonSource(actorSource));

  const peersSource = env["OPENCONDITIONS_FEDERATION_PEERS"];
  const peers =
    peersSource === undefined || peersSource.length === 0
      ? []
      : loadPeers(readJsonSource(peersSource));

  return { enabled: true, actor, peers };
}
