import type { PinnedSet } from "../pinned.js";

/**
 * Open Charge Map's API description and reference data: the OpenAPI 3
 * description `Model/schema/ocm-openapi-spec.yaml` of
 * `openchargemap/ocm-docs` (MIT), pinned at commit
 * `7698b44e776d4ff800f40efdb820b7e9a19fe85e`, and the reference data the API
 * serves at `/v3/referencedata` (connection, current, status, usage and
 * submission status types) as `data/referencedata.json` of
 * `openchargemap/ocm-export`, pinned at commit
 * `8e3bedca48ca94807d96b2f5e7ee02cffe63ae54`. A POI names each of these
 * types by its id; the reference data is what the ids mean. Retrieved
 * 2026-10-17. The export repository states no licence of its own; the data
 * is Open Charge Map's, so it is fetched, not vendored.
 */
export const OCM: PinnedSet = {
  id: "ocm-openapi-referencedata",
  files: [
    {
      name: "ocm-openapi-spec.yaml",
      url: "https://raw.githubusercontent.com/openchargemap/ocm-docs/7698b44e776d4ff800f40efdb820b7e9a19fe85e/Model/schema/ocm-openapi-spec.yaml",
      sha256: "b8a18cb73e98f686de43a99916640dd78d14a7ff0df5946b7f8d9e743cfef23f",
    },
    {
      name: "referencedata.json",
      url: "https://raw.githubusercontent.com/openchargemap/ocm-export/8e3bedca48ca94807d96b2f5e7ee02cffe63ae54/data/referencedata.json",
      sha256: "71c7ea6f70e8f360ff13cc64ada578d07c05af0bf9e92b5efeda591ff695f7e8",
    },
  ],
};
