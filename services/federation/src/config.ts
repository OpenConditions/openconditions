/**
 * Operator configuration for the federation service. Federation is OPT-IN
 * and off by default: without OPENCONDITIONS_FEDERATION_ENABLED the service
 * serves 404 on the well-known routes and never creates an instance key.
 * When enabled, an invalid or missing actor/peers config, or a missing or
 * malformed secrets key, fails the boot closed rather than serving a
 * half-formed identity.
 */
import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { resolveInstanceId, type SecretsKey, secretsKeyFromEnv } from "@openconditions/core/server";
import {
  type ActorConfig,
  loadPeers,
  type PeerRecord,
  parseActorConfig,
} from "@openconditions/federation";

export interface FederationSettings {
  enabled: boolean;
  /** Present iff enabled. */
  actor?: ActorConfig;
  /** The key the instance keys' private halves are sealed with. Present iff enabled. */
  secretsKey?: SecretsKey;
  /** This instance's declared peers (public metadata; empty by default). */
  peers: PeerRecord[];
  /** The static GeoParquet archive URL peers fetch for beyond-window backfill.
   *  Present iff enabled; defaults to `${baseUrl}/archive`. */
  archiveUrl?: string;
  /** The registry peers are discovered in, when one is configured. */
  registry?: RegistrySettings;
  /**
   * The request header a TLS-terminating proxy puts a verified client
   * certificate's fingerprint in, for peers that require mutual TLS; absent
   * when this process terminates TLS itself.
   */
  clientCertHeader?: string;
  /**
   * The reverse proxies in front of the service: the client certificate
   * header is taken only from them (from any connection when absent), and so
   * is `X-Forwarded-For`, which says the client address anonymous outbox
   * reads are metered by (the connection's own address when absent).
   */
  trustedProxies?: BlockList;
  /**
   * The client certificate this instance presents on every request to a
   * peer, for peers that require mutual TLS of it; absent when none is
   * configured.
   */
  clientCertificate?: ClientCertificate;
}

/** A client certificate and its private key, both PEM, read once at boot. */
export interface ClientCertificate {
  cert: string;
  key: string;
}

export interface RegistrySettings {
  /** Where the registry's TUF metadata is served (`<url>/metadata`). */
  metadataUrl: string;
  /** Where its target files, one per instance, are served (`<url>/targets`). */
  targetsUrl: string;
  /** The registry's trusted root metadata (`root.json`), obtained out of band. */
  root: string;
  /** Where the verified metadata is kept between syncs, for rollback protection. */
  cacheDir: string;
}

/** Accepts inline JSON (leading '{' or '[') or a path to a JSON file. */
function readJsonSource(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return readFileSync(trimmed, "utf8");
}

export function resolveFederationSettings(
  env: Record<string, string | undefined>,
): FederationSettings {
  const enabledFlag = env["OPENCONDITIONS_FEDERATION_ENABLED"];
  const enabled = enabledFlag === "true" || enabledFlag === "1";
  if (!enabled) return { enabled: false, peers: [] };

  const actorSource = env["OPENCONDITIONS_FEDERATION_ACTOR"];
  if (actorSource === undefined || actorSource.length === 0) {
    throw new Error(
      "federation is enabled but OPENCONDITIONS_FEDERATION_ACTOR is missing " +
        "(inline actor-config JSON or a path to a JSON file)",
    );
  }
  const actor = parseActorConfig(readJsonSource(actorSource));
  // The records this instance publishes carry the id its ingest stamps; a
  // peer refuses a record whose instance is not the one it pinned.
  const instanceId = resolveInstanceId(env as NodeJS.ProcessEnv);
  if (actor.instanceId !== instanceId) {
    throw new Error(
      `the federation actor is instance "${actor.instanceId}", but this instance's records ` +
        `carry OPENCONDITIONS_INSTANCE_ID "${instanceId}": set both to the same id`,
    );
  }

  const peersSource = env["OPENCONDITIONS_FEDERATION_PEERS"];
  const peers =
    peersSource === undefined || peersSource.length === 0
      ? []
      : loadPeers(readJsonSource(peersSource));
  if (peers.some((peer) => peer.instanceId === actor.instanceId)) {
    throw new Error(`invalid peers config: instance "${actor.instanceId}" is this instance`);
  }

  const archiveOverride = env["OPENCONDITIONS_FEDERATION_ARCHIVE_URL"]?.trim();
  const archiveUrl =
    archiveOverride && archiveOverride.length > 0
      ? archiveOverride
      : `${actor.baseUrl.replace(/\/$/, "")}/archive`;
  if (!URL.canParse(archiveUrl) || !/^https?:$/.test(new URL(archiveUrl).protocol)) {
    throw new Error("OPENCONDITIONS_FEDERATION_ARCHIVE_URL must be an http(s) URL");
  }

  const registry = resolveRegistry(env);
  const clientCertHeader = env["OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER"]
    ?.trim()
    .toLowerCase();
  if (clientCertHeader && !/^[a-z0-9-]+$/.test(clientCertHeader)) {
    throw new Error("OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER must be an HTTP header name");
  }
  // A proxy's header names a certificate; only a pinned one says whose.
  const unpinned = peers.filter(
    (peer) => peer.mtlsRequired === true && (peer.mtlsFingerprints ?? []).length === 0,
  );
  if (clientCertHeader && unpinned.length > 0) {
    throw new Error(
      `with OPENCONDITIONS_FEDERATION_CLIENT_CERT_HEADER, a peer that requires mutual TLS ` +
        `pins its certificate fingerprints: ${unpinned.map((p) => p.instanceId).join(", ")} does not`,
    );
  }
  const trustedProxies = resolveProxies(env["OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES"]);
  const clientCertificate = resolveClientCertificate(env);
  // The instance keys' private halves are sealed with it; without it no key
  // can be stored or used, so an enabled federation refuses to start.
  const secretsKey = secretsKeyFromEnv(env);
  return {
    enabled: true,
    actor,
    secretsKey,
    peers,
    archiveUrl,
    ...(registry ? { registry } : {}),
    ...(clientCertHeader ? { clientCertHeader } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(clientCertificate ? { clientCertificate } : {}),
  };
}

/**
 * The client certificate and its key, read and checked once: each as PEM in
 * its variable, or in the file its `_FILE` variant names. Undefined when
 * neither is set, a throw when one is missing, set both ways, unreadable, not
 * PEM, or the key is not the certificate's. No message names what they hold.
 */
function resolveClientCertificate(
  env: Record<string, string | undefined>,
): ClientCertificate | undefined {
  const CERT = "OPENCONDITIONS_FEDERATION_CLIENT_CERT";
  const KEY = "OPENCONDITIONS_FEDERATION_CLIENT_KEY";
  /** The PEM of `name` and where it came from, for messages; undefined when it is not set. */
  const pem = (name: string): { text: string; from: string } | undefined => {
    const inline = env[name]?.trim() ?? "";
    const file = env[`${name}_FILE`]?.trim() ?? "";
    if (inline !== "" && file !== "") {
      throw new Error(`${name} and ${name}_FILE are both set: set one`);
    }
    if (inline !== "") return { text: inline, from: name };
    if (file === "") return undefined;
    try {
      return { text: readFileSync(file, "utf8"), from: `${name}_FILE: ${file}` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
      throw new Error(`${name}_FILE: cannot read ${file} (${code})`);
    }
  };
  const certPem = pem(CERT);
  const keyPem = pem(KEY);
  if (certPem === undefined && keyPem === undefined) return undefined;
  if (certPem === undefined || keyPem === undefined) {
    throw new Error(
      `a client certificate needs both ${CERT} and ${KEY}, each as PEM or as a file named by its _FILE variant`,
    );
  }
  const cert = certPem.text;
  const key = keyPem.text;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert);
  } catch {
    throw new Error(`${certPem.from} is not a PEM certificate`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key);
  } catch {
    throw new Error(`${keyPem.from} is not a PEM private key`);
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error(`${keyPem.from} is not the key of the certificate (${certPem.from})`);
  }
  return { cert, key };
}

/** The proxies' addresses (`10.0.0.2`, `172.18.0.0/16`, `fd00::/8`); undefined when none are named. */
function resolveProxies(raw: string | undefined): BlockList | undefined {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const family = isIP(address) === 4 ? "ipv4" : isIP(address) === 6 ? "ipv6" : undefined;
    const bits = prefix === undefined ? undefined : Number(prefix);
    const max = family === "ipv4" ? 32 : 128;
    if (
      family === undefined ||
      (bits !== undefined && !(Number.isInteger(bits) && bits >= 0 && bits <= max))
    ) {
      throw new Error(
        `OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES: "${entry}" is not an address or subnet`,
      );
    }
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, bits, family);
  }
  return list;
}

/** The registry settings; undefined when none is configured, a throw when half is. */
function resolveRegistry(env: Record<string, string | undefined>): RegistrySettings | undefined {
  const url = env["OPENCONDITIONS_FEDERATION_REGISTRY_URL"]?.trim() ?? "";
  const rootSource = env["OPENCONDITIONS_FEDERATION_REGISTRY_ROOT"]?.trim() ?? "";
  if (url === "" && rootSource === "") return undefined;
  if (url === "" || rootSource === "") {
    throw new Error(
      "a federation registry needs both OPENCONDITIONS_FEDERATION_REGISTRY_URL and " +
        "OPENCONDITIONS_FEDERATION_REGISTRY_ROOT (its root.json, inline or a path)",
    );
  }
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error("OPENCONDITIONS_FEDERATION_REGISTRY_URL must be an http(s) URL");
  }
  const base = url.replace(/\/$/, "");
  const cacheDir = env["OPENCONDITIONS_FEDERATION_REGISTRY_CACHE"]?.trim() || "./data/registry";
  return {
    metadataUrl: `${base}/metadata`,
    targetsUrl: `${base}/targets`,
    root: readJsonSource(rootSource),
    cacheDir,
  };
}
