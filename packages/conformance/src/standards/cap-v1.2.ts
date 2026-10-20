import type { PinnedSet } from "../pinned.js";

/**
 * OASIS Common Alerting Protocol 1.2 (OASIS Standard, 1 July 2010): the
 * schema from https://docs.oasis-open.org/emergency/cap/v1.2/, the directory
 * the standard's own document (`CAP-v1.2-os.html`) is published in; its
 * `os/CAP-v1.2-os.xsd` is the same file byte for byte. Retrieved 2026-10-17.
 * The file carries only "Copyright OASIS Open 2010 All Rights Reserved"; the
 * standard's Notices allow copies "provided that the above copyright notice
 * and this section are included" and forbid modifying the document, under the
 * OASIS IPR Policy. That licenses the standard, not the repository's Apache
 * terms, so it is fetched, not vendored.
 *
 * The schema declares its enumerations as anonymous types inside the elements
 * that use them (`status`, `msgType`, `scope`, `category`, `responseType`,
 * `urgency`, `severity`, `certainty`), not as named simple types.
 */
export const CAP_V1_2: PinnedSet = {
  id: "cap-v1.2",
  files: [
    {
      name: "CAP-v1.2.xsd",
      url: "https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.xsd",
      sha256: "b7798ef25868b068c97b268bda02d067c7d4ba9373adc5638bf37105804ee723",
    },
  ],
};

/**
 * The four messages of the standard's Appendix A, as OASIS publishes them
 * beside the standard in https://docs.oasis-open.org/emergency/cap/v1.2/os/:
 * A.1 the Homeland Security Advisory System alert (`example1.xml`), A.2 the
 * severe thunderstorm warning (`example2.xml`), A.3 the earthquake report, an
 * Update (`example3.xml`), and A.4 the AMBER alert in English and Spanish
 * (`example4.xml`). Retrieved 2026-10-21. They are part of the standard and
 * under its Notices, like the schema, so they are fetched, not vendored.
 *
 * Two deviate from the standard: A.1's resource has no `mimeType`, which
 * CAP 1.2 requires, and A.4 declares UTF-8 but is written in ISO-8859-1.
 */
export const CAP_V1_2_EXAMPLES: PinnedSet = {
  id: "cap-v1.2-examples",
  files: [
    {
      name: "example1.xml",
      url: "https://docs.oasis-open.org/emergency/cap/v1.2/os/example1.xml",
      sha256: "fa15416611bd82259ba7a5eaa059091cf2646c34c2b9c3cc93202dc93a5c85ae",
    },
    {
      name: "example2.xml",
      url: "https://docs.oasis-open.org/emergency/cap/v1.2/os/example2.xml",
      sha256: "6050ed6e13ea4fbd04de0447a6fe8d3c57082de23a3a322102d7656a3b794d22",
    },
    {
      name: "example3.xml",
      url: "https://docs.oasis-open.org/emergency/cap/v1.2/os/example3.xml",
      sha256: "11742bbd4df161e97e866686f872cbd0437e6493e9a8bd82f304b60d16f804f7",
    },
    {
      name: "example4.xml",
      url: "https://docs.oasis-open.org/emergency/cap/v1.2/os/example4.xml",
      sha256: "2d2e46c451fa2335772d917ac3fed71b4ef290b01638b07e44e22114affcab2e",
    },
  ],
};

/** The root schema of a CAP 1.2 `alert` document. */
export const CAP_SCHEMA = "CAP-v1.2.xsd";

/** The CAP 1.2 namespace an `alert` is in. */
export const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
