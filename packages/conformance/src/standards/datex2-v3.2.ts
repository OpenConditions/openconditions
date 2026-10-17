import type { PinnedSet } from "../pinned.js";

/**
 * DATEX II v3.2 with the parking schema that still has the record-based
 * parking model: the per-namespace schemas linked from
 * https://docs.datex2.eu/downloads/modelv32/ (served under `BASE`), plus
 * `DATEXII_3_Parking.xsd` from the same directory, which that page does not
 * link and which declares itself `version="3.1"`. It is the last published v3
 * parking schema with `ParkingRecord`, `parkingRecordStatus` and
 * `ParkingSiteStatusEnum`; v3.3 and later replace them with the facility
 * hierarchy (`hierarchyElementGeneral`, `parkingStatusInformation`). NDW's v3
 * truck parking status follows it, `par:` reference classes included.
 * Retrieved 2026-10-17. datex2.eu and docs.datex2.eu publish the schemas
 * without any licence or redistribution terms (only "Copyright © DATEX II"),
 * so they are fetched, not vendored.
 *
 * The v3.2 `DATEXII_3_D2Payload.xsd` does not import the parking namespace, so
 * a parking payload is checked against a root that imports both, as
 * `PARKING_PAYLOAD_ROOT` does.
 */
const BASE = "https://docs.datex2.eu/_static/data/v3.2/";

const file = (name: string, sha256: string) => ({ name, url: `${BASE}${name}`, sha256 });

export const DATEX2_V3_2: PinnedSet = {
  id: "datex2-v3.2",
  files: [
    file(
      "DATEXII_3_Common.xsd",
      "f38887b24c19ab09a86aeca17e2f1cdf719ce441789733f2827dc1fd2e7b73bf",
    ),
    file(
      "DATEXII_3_CommonExtension.xsd",
      "b88bd57427cca456506e5801ce8a5446bfb1e418b94f5e90d5398a3de8739bde",
    ),
    file(
      "DATEXII_3_D2Payload.xsd",
      "e340400fa5739cd96b238c3cf7e40b6e3a49c46913a4483da421831756237f34",
    ),
    file(
      "DATEXII_3_EnergyInfrastructure.xsd",
      "a888a6d4618d20c666e3ab05b058df1c7ed6d12acd56ee4f33230a61232f0d51",
    ),
    file(
      "DATEXII_3_Facilities.xsd",
      "7f1d16250df819b0dd3a77aa1f1c6c396a08d9e7ede6a7bca728f6ab8a77cc98",
    ),
    file(
      "DATEXII_3_LocationExtension.xsd",
      "c1be9a19ed3c0833ed973fddbc0bc6f47dddaffaec7fd3b83bbd00b82e7af523",
    ),
    file(
      "DATEXII_3_LocationReferencing.xsd",
      "285e526287c883a5e855689de3f2fa8819ed997012f16047ac85039879f0e90f",
    ),
    file(
      "DATEXII_3_Parking.xsd",
      "81b94135927f9c9eb3b0a5acd7ba48c82fc0b09d0ecbdd49c98545ae2a60b68d",
    ),
    file(
      "DATEXII_3_RoadTrafficData.xsd",
      "a1952e890f59db43d51a45b8e56c6c470268fbae1151ff27ec69a1058d2ab7f6",
    ),
    file(
      "DATEXII_3_Situation.xsd",
      "3d4b510342e07185e4dbb459bc8a8cf0731fc0671472fbcb4ecf1d6c0c498370",
    ),
    file(
      "DATEXII_3_TrafficRegulation.xsd",
      "51d1720f6a2d56dff7a2cabf9fbfe74c1c60432d6374805161a2b4c071ed9700",
    ),
    file("DATEXII_3_Vms.xsd", "2c6c377884befd664b1450a81f368edbd346cacac2476693252ba69814f887ff"),
  ],
};

/** The name `PARKING_PAYLOAD_ROOT` is known by among the schema files. */
export const PARKING_PAYLOAD_SCHEMA = "parking-payload-root.xsd";

/**
 * A schema of no namespace of its own that imports the payload and parking
 * namespaces, so a `payload` element carrying a parking publication resolves
 * its `xsi:type`. Add it to the pinned files and validate against
 * `PARKING_PAYLOAD_SCHEMA`.
 */
export const PARKING_PAYLOAD_ROOT = {
  fileName: PARKING_PAYLOAD_SCHEMA,
  contents: `<?xml version="1.0" encoding="utf-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:openconditions:conformance:parking-payload">
  <xs:import namespace="http://datex2.eu/schema/3/d2Payload" schemaLocation="DATEXII_3_D2Payload.xsd"/>
  <xs:import namespace="http://datex2.eu/schema/3/parking" schemaLocation="DATEXII_3_Parking.xsd"/>
</xs:schema>`,
};
