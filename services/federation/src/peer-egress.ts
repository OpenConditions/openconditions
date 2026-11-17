/**
 * The guarded fetch every request to a peer goes through: its pull, the
 * comparison of copies, the webhook push, the subscription upkeep, the
 * capability refresh and the archive download. With a configured client
 * certificate it presents that certificate, for peers that require mutual
 * TLS of this instance. The registry is not a peer and is fetched without it.
 */
import {
  type FetchGuardOptions,
  guardedFetch,
  guardOptionsFromEnv,
} from "@openconditions/ingest-framework";
import type { FederationSettings } from "./config.js";

/** A guarded fetch for requests to peers, presenting the client certificate of `settings` when one is configured. */
export function peerFetch(
  settings: Pick<FederationSettings, "clientCertificate">,
  opts: FetchGuardOptions = guardOptionsFromEnv(),
  /** A certificate authority (PEM) to trust besides the system's, for a test's own server. */
  ca?: string,
): typeof fetch {
  const client = settings.clientCertificate;
  return guardedFetch(undefined, opts, {
    ...(client === undefined ? {} : { cert: client.cert, key: client.key }),
    ...(ca === undefined ? {} : { ca }),
  });
}
