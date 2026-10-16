import { type CrowdCredit, captureLicensing } from "@openconditions/ingest-framework";
import type { Attribution } from "@openconditions/model";

/** The server-owned attribution stamped on newly accepted crowd acquisitions. */
export function captureCrowdAttribution(crowd: CrowdCredit): Attribution {
  return {
    provider: crowd.name,
    license: crowd.license,
    licensing: captureLicensing({ id: "crowd", name: crowd.name, license: crowd.license }),
    ...(crowd.url ? { url: crowd.url } : {}),
  };
}
