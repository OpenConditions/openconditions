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

/** The root schema of a CAP 1.2 `alert` document. */
export const CAP_SCHEMA = "CAP-v1.2.xsd";

/** The CAP 1.2 namespace an `alert` is in. */
export const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
