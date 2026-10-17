import type { PinnedSet } from "../pinned.js";

/**
 * ParkAPI v3: the public OpenAPI 3.1 document of the ParkAPI service, as
 * MobiData BW serves it at `PUBLIC_DOC`, the "public endpoints" documentation
 * the ParkAPI README (https://github.com/ParkenDD/park-api-v3) names as the
 * data model's definition. Retrieved 2026-10-17. ParkAPI generates the
 * document from its code at run time and neither the repository nor its
 * releases carry a copy, so the service's own is the authoritative one. It
 * is ParkAPI 0.49.2 (released 2026-10-03), whatever its `info.version` says:
 * it has the `restrictions` model with `hours` and `max_stay`, lacks
 * `restricted_to` and `is_supervised` (removed in 0.49.1), and describes
 * `has_realtime_data` as 0.49.2 changed it. The ParkAPI code is MIT-licensed;
 * the service publishes the document under the MobiData BW terms of use
 * (https://www.mobidata-bw.de/pages/nutzungsbedingungen), which grant no
 * licence to copy it, so it is fetched, not vendored. The service replaces
 * the document with each deployment, so it is fetched from the Internet
 * Archive's capture of 2026-10-17, byte-identical to what the service served
 * that day: a deployment then never fails the check, and moving to a new
 * version is a deliberate re-pin.
 */
const PUBLIC_DOC = "https://api.mobidata-bw.de/park-api/documentation/public.json";

export const PARKAPI_V3: PinnedSet = {
  id: "parkapi-v3-0.49.2",
  files: [
    {
      name: "public.json",
      url: `https://web.archive.org/web/20261017114247id_/${PUBLIC_DOC}`,
      sha256: "a8ebde806d1aedeebc2fb436471fb0fe4f4d7a72c51bc71b0881d1ef737b7f0b",
    },
  ],
};
