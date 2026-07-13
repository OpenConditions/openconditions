/**
 * Fastify app for the federation service — the HTTP face of the instance's
 * federated identity. v1 serves only the discovery surface: the Actor
 * document and the declared-peers list under /.well-known/openconditions/.
 * The peer exchange endpoints the Actor document advertises (outbox, inbox,
 * subscribe, …) land with the federation wire protocol in a later task.
 * Exported as build() so tests can fastify.inject; only main.ts listens.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type postgres from "postgres";
import {
  ACTIVITY_JSON,
  ACTOR_WELL_KNOWN_PATH,
  PEERS_WELL_KNOWN_PATH,
  buildActorDocument,
  ensureInstanceKey,
  loadActiveKeys,
} from "@openconditions/federation";
import { resolveFederationSettings } from "./config.js";

export interface BuildOptions {
  sql: postgres.Sql;
  env?: Record<string, string | undefined>;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock (ISO 8601); defaults to the real clock. */
  now?: () => string;
}

export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const { sql } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // Throws (failing the boot closed) when enabled with a bad config.
  const settings = resolveFederationSettings(env);

  const app = Fastify({ logger: options.logger ?? true });

  app.get("/status", async (_req, reply) => {
    return reply.send({
      status: "ok",
      service: "openconditions-federation-api",
      federation: settings.enabled,
    });
  });

  if (!settings.enabled) {
    for (const path of [ACTOR_WELL_KNOWN_PATH, PEERS_WELL_KNOWN_PATH]) {
      app.get(path, async (_req, reply) => {
        return reply.status(404).send({ error: "federation is disabled on this instance" });
      });
    }
    return app;
  }

  const actorConfig = settings.actor!;
  await ensureInstanceKey(sql, now());

  app.get(ACTOR_WELL_KNOWN_PATH, async (_req, reply) => {
    // Keys are read per request so a rotation shows up without a restart.
    // Self-heal an all-expired table (e.g. a very long-lived process that
    // never rotated) instead of serving an actor document with no keys.
    let keys = await loadActiveKeys(sql, now());
    if (keys.length === 0) {
      await ensureInstanceKey(sql, now());
      keys = await loadActiveKeys(sql, now());
    }
    const doc = buildActorDocument(actorConfig, keys);
    return reply.type(ACTIVITY_JSON).send(JSON.stringify(doc));
  });

  app.get(PEERS_WELL_KNOWN_PATH, async (_req, reply) => {
    return reply.send({ peers: settings.peers });
  });

  return app;
}
