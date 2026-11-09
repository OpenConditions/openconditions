/** SMHI HTTP pacing is separate from publication state: rejected parses must still respect it. */
export class SmhiHttpPolicy {
  private readonly deadlines = new Map<string, number>();
  private blockedUntil = 0;
  private failures = 0;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  ready(urls: readonly string[], at: number): boolean {
    return at >= this.blockedUntil && urls.every((url) => at >= (this.deadlines.get(url) ?? 0));
  }

  wrap(upstream: typeof fetch, deadline = Infinity): typeof fetch {
    return ((input, init) => {
      const url = String(input);
      const run = this.turn.then(async () => {
        const sent = this.now();
        if (sent >= deadline) throw new Error("SMHI cumulative acquisition deadline");
        if (!this.ready([url], sent)) throw new Error("SMHI HTTP cache/backoff deadline");
        try {
          const budget = Number.isFinite(deadline)
            ? AbortSignal.timeout(Math.max(1, Math.ceil(deadline - sent)))
            : undefined;
          const response = await upstream(
            input,
            budget
              ? { ...init, signal: init?.signal ? AbortSignal.any([init.signal, budget]) : budget }
              : init,
          );
          const received = this.now();
          if (response.status === 429 || response.status === 503) {
            const retry = response.headers.get("retry-after");
            const retryAt =
              retry !== null && /^\d+$/.test(retry)
                ? received + Number(retry) * 1000
                : Date.parse(retry ?? "");
            this.backoff(received, Number.isFinite(retryAt) ? retryAt : 0);
          } else if (response.ok || response.status === 304) {
            const cache = response.headers.get("cache-control") ?? "";
            const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(cache);
            const date = Date.parse(response.headers.get("date") ?? "");
            const age = Number(response.headers.get("age") ?? "0");
            const currentAge = Math.max(
              Number.isFinite(date) ? Math.max(0, received - date) : 0,
              Number.isFinite(age) && age >= 0 ? age * 1000 + received - sent : Infinity,
            );
            const lifetime =
              maxAge && !/(?:^|,)\s*(?:no-cache|no-store)\b/i.test(cache)
                ? Number(maxAge[1]) * 1000
                : 0;
            if (maxAge && currentAge >= Number(maxAge[1]) * 1000 && Number(maxAge[1]) > 0) {
              await response.body?.cancel();
              throw new Error("SMHI stale HTTP response (Date/Age exceeds max-age)");
            }
            this.failures = 0;
            this.deadlines.set(url, received + Math.max(0, lifetime - currentAge));
          } else {
            this.backoff(received, 0);
          }
          if (!response.ok && response.status !== 304) await response.body?.cancel();
          return response;
        } catch (error) {
          this.backoff(this.now(), 0);
          throw error;
        }
      });
      this.turn = run.catch(() => {});
      return run;
    }) as typeof fetch;
  }

  private backoff(received: number, retryAt: number): void {
    this.failures = Math.min(this.failures + 1, 7);
    this.blockedUntil = Math.max(
      this.blockedUntil,
      retryAt,
      received + Math.min(3600000, 600000 * 2 ** (this.failures - 1)),
    );
  }
}

const policies = new WeakMap<object, SmhiHttpPolicy>();
const ordinaryPolicy = new SmhiHttpPolicy();
export function smhiHttpPolicy(owner?: object): SmhiHttpPolicy {
  if (!owner) return ordinaryPolicy;
  let policy = policies.get(owner);
  if (!policy) {
    policy = new SmhiHttpPolicy();
    policies.set(owner, policy);
  }
  return policy;
}
