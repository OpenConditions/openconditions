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

function ddmmyyyy(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}${mon}${d.getUTCFullYear()}`;
}

/**
 * Stamps a rolling one-day window (yesterday → today, DDMMYYYY UTC) into a
 * WebTRIS daily-report URL by replacing the `{start_date}`/`{end_date}`
 * tokens. WebTRIS requires an explicit date range and has no "latest"
 * shortcut.
 */
const webtrisDailyWindow: PreFetchHook = async (src) => {
  const url = Array.isArray(src.url) ? src.url[0] : src.url;
  if (typeof url !== "string") return src;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const stamped = url
    .replace("{start_date}", ddmmyyyy(yesterday))
    .replace("{end_date}", ddmmyyyy(today));
  return { ...src, url: stamped };
};

export const PRE_FETCH_HOOKS: Record<string, PreFetchHook> = { webtrisDailyWindow };

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
