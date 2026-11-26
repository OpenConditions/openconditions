import type { PinnedSet } from "../pinned.js";

/**
 * Waze / Google Closure and Incident Feed Specification (CIFS) v2 XML schema:
 * https://www.gstatic.com/road-incidents/cifsv2.xsd, referenced from
 * https://developers.google.com/waze/data-feed/feed-setup. Retrieved 2026-11-26.
 * The schema carries no inline open-source licence header, so it is fetched
 * pinned by SHA-256 rather than vendored into this repository.
 *
 * The schema declares its enumerations as anonymous simple types inside their
 * elements (`type`, `subtype`, `direction`, `roadside`, `status`), with no
 * targetNamespace.
 */
export const CIFS_V2: PinnedSet = {
  id: "cifs-v2",
  files: [
    {
      name: "cifsv2.xsd",
      url: "https://www.gstatic.com/road-incidents/cifsv2.xsd",
      sha256: "a82ffb2cd92610a739bc55c9ab4b270e66e74cb546a9f5e59a34ce9af45e0f6b",
    },
  ],
};

/** The root schema of a CIFS v2 `incidents` document. */
export const CIFS_SCHEMA = "cifsv2.xsd";
