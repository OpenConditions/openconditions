import type { Env } from "./auth.js";
import type { FeedSourceBase } from "./feed-source.js";

/**
 * A reactive pre-fetch transform: given a feed and the resolved env, return a
 * possibly-rewritten descriptor (e.g. a scraped session URL, a date-stamped path).
 * Runs before URL resolution. Intentionally empty until a feed that needs it lands
 * (the login-then-session-cookie class); adding one is a deliberate, reviewed step.
 */
export type PreFetchHook = (
  src: FeedSourceBase,
  env: Env,
  fetchFn: typeof fetch
) => Promise<FeedSourceBase>;

export const PRE_FETCH_HOOKS: Record<string, PreFetchHook> = {};

export async function applyPreFetch(
  src: FeedSourceBase,
  env: Env,
  fetchFn: typeof fetch
): Promise<FeedSourceBase> {
  if (!src.preFetch) return src;
  const hook = PRE_FETCH_HOOKS[src.preFetch];
  if (!hook) throw new Error(`feed ${src.id} references unknown preFetch hook ${src.preFetch}`);
  return hook(src, env, fetchFn);
}
