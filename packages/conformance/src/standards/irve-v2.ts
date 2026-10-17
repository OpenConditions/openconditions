import type { PinnedSet } from "../pinned.js";

/**
 * France's IRVE schemas 2.3.1 (etalab/schema-irve, release `v2.3.1` of
 * 2025-12-02): the Frictionless Table Schemas of the static file, one row per
 * charge point, and of the dynamic one, a status per charge point, as
 * https://schema.data.gouv.fr/etalab/schema-irve-statique.html and
 * `schema-irve-dynamique.html` publish them under their versioned URLs. They
 * are the same bytes as `statique/schema-statique.json` and
 * `dynamique/schema-dynamique.json` at the tag on GitHub, and as the
 * catalogue's `latest`. Retrieved 2026-10-17. The national consolidation and
 * the dynamic file the `irve` feed reads publish the 2.x columns, of which
 * 2.3.1 is the last release; the v3 alpha of 2026-10-05 renames and splits
 * columns (`coordonneesXY` into two) that neither file has adopted.
 * Neither the schemas, the data package nor the repository state a licence
 * (GitHub reports none), so they are fetched, not vendored.
 */
const BASE = "https://schema.data.gouv.fr/schemas/etalab";

export const IRVE_V2: PinnedSet = {
  id: "irve-v2.3.1",
  files: [
    {
      name: "schema-statique.json",
      url: `${BASE}/schema-irve-statique/2.3.1/schema-statique.json`,
      sha256: "f494d57aebc64a87694574de0545dbf4ff804fe8d53422104b08cb3e0457a4ff",
    },
    {
      name: "schema-dynamique.json",
      url: `${BASE}/schema-irve-dynamique/2.3.1/schema-dynamique.json`,
      sha256: "8139db1a9b9385855e657822edf66faac3323fc064f22d8e3ecf4aa09b08de63",
    },
  ],
};

/** The static schema's file name in the set. */
export const IRVE_STATIC_SCHEMA = "schema-statique.json";
/** The dynamic schema's file name in the set. */
export const IRVE_DYNAMIC_SCHEMA = "schema-dynamique.json";
