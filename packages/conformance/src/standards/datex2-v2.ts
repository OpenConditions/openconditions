import type { PinnedSet } from "../pinned.js";

/**
 * DATEX II v2.3: the level-A schema `DATEXIISchema_2_2_3.xsd` (namespace
 * `http://datex2.eu/schema/2/2_0`) from `DATEXIISchema_2_2_3_0.zip`, listed as
 * "DATEX II XML Schema 2.3" on https://docs.datex2.eu/downloads/modelv23/.
 * Retrieved 2026-10-17; the old datex2.eu schema path now answers 404. The
 * archive also holds the same schema with its definitions as annotations,
 * which validates identically and is not pinned. datex2.eu and docs.datex2.eu
 * publish the schema without any licence or redistribution terms (only
 * "Copyright © DATEX II"), so it is fetched, not vendored.
 *
 * v2.3 is the last release of the v2 line and is backward compatible with
 * v2.0 to v2.2, which share its namespace: a v2.x document is checked against
 * it. No level-B extension schema is pinned; v2 extensions travel in the
 * `...Extension` elements, whose content the schema leaves open.
 */
export const DATEX2_V2: PinnedSet = {
  id: "datex2-v2.3",
  archives: [
    {
      url: "https://docs.datex2.eu/_static/data/v2.3/DATEXIISchema_2_2_3_0.zip",
      members: {
        "DATEXIISchema_2_2_3.xsd":
          "cf628bc92d614225b6e3a0337a54cafed4e393bb22659a19b7f28620b94f63d6",
      },
    },
  ],
};

/** The v2.3 schema file, which declares the `d2LogicalModel` root element. */
export const D2_LOGICAL_MODEL_SCHEMA = "DATEXIISchema_2_2_3.xsd";

/** The DATEX II v2 namespace, shared by v2.0 to v2.3. */
export const DATEX2_V2_NAMESPACE = "http://datex2.eu/schema/2/2_0";
