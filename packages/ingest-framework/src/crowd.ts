import { licenseInfo } from "./catalog/licenses.js";

/** How an instance credits its crowd reports, as its environment configures it. */
export interface CrowdCredit {
  /** `OpenConditions contributors at <instanceId>`. */
  name: string;
  /** `OPENCONDITIONS_CROWD_LICENSE`, ODbL by default: an id of the licence registry. */
  license: string;
  /** `OPENCONDITIONS_CROWD_SOURCE_URI`, the link the credit carries. */
  url?: string;
}

/**
 * The crowd credit of the instance `instanceId`. Both services that state it,
 * the contributions API on every report it lands and the ingest service in
 * `/sources`, read the same variables. Throws on a licence id the registry
 * does not know (lookup is exact, case included) and on a link that is no
 * http(s) URL, so a misconfiguration fails the boot instead of reaching
 * egress.
 */
export function resolveCrowdCredit(
  env: Record<string, string | undefined>,
  instanceId: string,
): CrowdCredit {
  const license = env["OPENCONDITIONS_CROWD_LICENSE"]?.trim() || "ODbL-1.0";
  if (!licenseInfo(license)) {
    throw new Error(
      `OPENCONDITIONS_CROWD_LICENSE "${license}" is not a known licence id: use an SPDX id or LicenseRef-<name> from the licence registry, matching case exactly (e.g. ODbL-1.0)`,
    );
  }
  const url = env["OPENCONDITIONS_CROWD_SOURCE_URI"]?.trim();
  if (url && !isWebUrl(url)) {
    throw new Error(`OPENCONDITIONS_CROWD_SOURCE_URI "${url}" is not an http(s) URL`);
  }
  return {
    name: `OpenConditions contributors at ${instanceId}`,
    license,
    ...(url ? { url } : {}),
  };
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
