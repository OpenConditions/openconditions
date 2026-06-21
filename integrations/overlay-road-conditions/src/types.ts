import type { Sql } from "postgres";

/**
 * Minimal shim for the integration context.
 *
 * The real IntegrationContext comes from @openmapx/integration-framework (unpublished).
 * When this package is wired into the OpenMapX monorepo the `import type` here is
 * replaced by the real import and this file is removed.
 *
 * monorepo-wired: swap types.ts for @openmapx/integration-framework IntegrationContext
 */

export interface MinimalRequest {
  query: Record<string, string | undefined>;
}

export interface MinimalReply {
  status(code: number): this;
  header(name: string, value: string): this;
  send(body: unknown): this;
}

export type RouteHandler = (req: MinimalRequest, reply: MinimalReply) => Promise<MinimalReply | void>;

export interface IntegrationContext {
  db: Sql;
  cache: {
    withCache<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
  };
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  manifest: {
    dataSources?: unknown[];
  };
}
