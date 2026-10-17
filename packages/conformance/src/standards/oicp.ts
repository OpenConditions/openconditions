import type { PinnedSet } from "../pinned.js";

/**
 * Hubject's OICP 2.3 for EMPs as its OpenAPI 3.0 description: the
 * `openapi.yaml` that the `hubject/oicp-emp-2.3-api-doc` repository bundles
 * from its sources onto its `gh-pages` branch, which the specification
 * repository (`hubject/oicp`, `OICP-2.3/SWAGGER DOCUMENTATION/README.md`)
 * names as the 2.3 API documentation. It holds the pull EVSE data and status
 * responses, `PullEvseDataRecord` with every field of `EvseDataRecord` and
 * the operator's id and name, and the enumerations the records use. Pinned at
 * the `gh-pages` commit `a398b8a8a75ba1fe4faa5aa0e8defa06af3b9a85` (the
 * deploy of `master` 9a773b3a of 2025-03-03). Retrieved 2026-10-17.
 *
 * The repository states no licence (its `package.json` names ISC for the
 * tooling); the specification text in `hubject/oicp` is CC BY-SA 4.0.
 * Either way the file is fetched, not vendored.
 */
export const OICP_2_3: PinnedSet = {
  id: "oicp-2.3-emp-openapi",
  files: [
    {
      name: "openapi.yaml",
      url: "https://raw.githubusercontent.com/hubject/oicp-emp-2.3-api-doc/a398b8a8a75ba1fe4faa5aa0e8defa06af3b9a85/openapi.yaml",
      sha256: "c4693c8a0534ac913407db3271225890e779dd1d03cf34d5cd0201da3f4b459d",
    },
  ],
};
