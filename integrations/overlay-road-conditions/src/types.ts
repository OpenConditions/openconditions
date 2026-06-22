/**
 * Minimal shim for the integration context.
 *
 * The real IntegrationContext comes from @openmapx/integration-framework — host-injected
 * at runtime, and re-exported for build-time by the published @openmapx/extension-sdk.
 * When wired into the OpenMapX monorepo, swap this file for that import.
 *
 * `db` mirrors OpenMapX's `DatabaseClient` exactly (positional-parameter `execute`), and is
 * present only when the manifest declares `requires: [{ service: "postgis" }]`.
 *
 * monorepo-wired: swap types.ts for the @openmapx/extension-sdk IntegrationContext
 */

export interface MinimalRequest {
  query: Record<string, string | undefined>;
}

export interface MinimalReply {
  status(code: number): this;
  header(name: string, value: string): this;
  send(body: unknown): this;
}

export type RouteHandler = (
  req: MinimalRequest,
  reply: MinimalReply
) => Promise<MinimalReply | void>;

/** Matches OpenMapX `IntegrationContext.db` (DatabaseClient). */
export interface DatabaseClient {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export interface IntegrationContext {
  db?: DatabaseClient;
  cache: {
    withCache<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
  };
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  manifest: {
    dataSources?: unknown[];
  };
}
