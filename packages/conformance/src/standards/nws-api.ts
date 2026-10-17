import type { PinnedSet } from "../pinned.js";

/**
 * The weather.gov API's OpenAPI 3.1 document (API version 3.12.2), served at
 * https://api.weather.gov/openapi.json and linked as the specification from
 * https://www.weather.gov/documentation/services-web-api. Retrieved
 * 2026-10-17. Its `Alert` schema is the National Weather Service's own
 * definition of the GeoJSON alert properties: CAP 1.2's fields, with
 * `messageType` for `msgType`, `response` for `responseType`, one category
 * and one response, and the API's own additions (`affectedZones`, `ends`).
 * A work of the U.S. Government, in the public domain
 * (https://www.weather.gov/disclaimer). The service replaces the document
 * with each release, so it is fetched from the Internet Archive's capture of
 * 2026-10-12, byte-identical to what the service served on 2026-10-17: a
 * release then never fails the check, and moving to a new one is a deliberate
 * re-pin.
 */
export const NWS_API: PinnedSet = {
  id: "nws-api-3.12.2",
  files: [
    {
      name: "openapi.json",
      url: "https://web.archive.org/web/20261012192356id_/https://api.weather.gov/openapi.json",
      sha256: "ae478b69cdac6449e3b834dca636300f830dde552ac6abc180b1d5e82e2f1d35",
    },
  ],
};
