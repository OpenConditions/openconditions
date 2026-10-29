import {
  type CatalogFeed,
  type Env,
  feedSecretValues,
  redactSecrets,
  redactUrl,
} from "@openconditions/ingest-framework";

/** Only a scrubbed message crosses a feed's logging/status boundary, never its stack or cause. */
export function feedErrorMessage(
  feed: CatalogFeed,
  error: unknown,
  env: Env = process.env,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = feedSecretValues(feed, env);
  // Keep query values before blanking the URL, so repeated copies are scrubbed too.
  for (const match of message.matchAll(/https?:\/\/\S+/g)) {
    try {
      for (const value of new URL(match[0]).searchParams.values()) secrets.push(value);
    } catch {
      // Malformed URL-looking strings still receive redactUrl's fallback below.
    }
  }
  return redactSecrets(
    message.replace(/https?:\/\/\S+/g, (url) => redactUrl(url)),
    secrets,
  );
}
