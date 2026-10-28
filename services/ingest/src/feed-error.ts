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
  return redactSecrets(
    message.replace(/https?:\/\/\S+/g, (url) => redactUrl(url)),
    feedSecretValues(feed, env),
  );
}
