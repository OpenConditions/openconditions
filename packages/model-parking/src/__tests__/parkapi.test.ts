import { jsonSchemaEnums, pinnedOrUnavailable } from "@openconditions/conformance";
import { PARKAPI_V3 as PINNED } from "@openconditions/conformance/standards/parkapi-v3";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PARKAPI_KERB_POSITIONS,
  PARKAPI_LINE_POSITIONS,
  PARKAPI_ORIENTATIONS,
  PARKAPI_RESTRICTION_AREAS,
  PARKAPI_SIDES,
  PARKAPI_SUPERVISION,
} from "../crosswalk/parkapi.js";
import { PARKAPI_V3 } from "../vocabularies/parkapi.js";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("ParkAPI v3 vocabularies against the OpenAPI document", () => {
  let enums = new Map<string, string[]>();
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(PINNED);
    if ("unavailable" in pinned) unavailable = pinned.unavailable;
    else enums = jsonSchemaEnums(JSON.parse(pinned.files[0]!.contents));
  }, 120_000);

  const schema = (pointer: string) => {
    const values = enums.get(`#/components/schemas/${pointer}`);
    if (!values) throw new Error(`the document enumerates nothing at ${pointer}`);
    return sorted(values);
  };

  it.for([
    ["siteTypes", "ParkingSite/properties/type"],
    ["purposes", "ParkingSite/properties/purpose"],
    ["restrictionTypes", "ParkingSiteRestriction/properties/type"],
    ["parkAndRideTypes", "ParkingSite/properties/park_and_ride_type/items"],
    ["supervisionTypes", "ParkingSite/properties/supervision_type"],
    ["openingStatuses", "ParkingSite/properties/realtime_opening_status"],
    [
      "externalIdentifierTypes",
      "ParkingSite/properties/external_identifiers/items/properties/type",
    ],
    ["orientations", "ParkingSite/properties/orientation"],
    ["sides", "ParkingSite/properties/side"],
    ["parkingTypes", "ParkingSite/properties/parking_type"],
    ["linearParkingPositions", "ParkingSite/properties/linear_parking_position"],
    ["geometryTypes", "ParkingSite/properties/geojson/properties/type"],
    ["sourceStatuses", "Source/properties/static_status"],
    ["sourceStatuses", "Source/properties/realtime_status"],
  ] as const)("%s is the enumeration at %s", ([list, pointer], { skip }) => {
    if (unavailable) skip(unavailable);
    expect(sorted(PARKAPI_V3[list])).toEqual(schema(pointer));
  });

  it("the crosswalks name every audience and supervision the document does", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(sorted(Object.keys(PARKAPI_RESTRICTION_AREAS))).toEqual(
      schema("ParkingSiteRestriction/properties/type"),
    );
    expect(sorted(Object.keys(PARKAPI_SUPERVISION))).toEqual(
      schema("ParkingSite/properties/supervision_type"),
    );
  });

  it.for([
    ["ParkingSite/properties/orientation", PARKAPI_ORIENTATIONS],
    ["ParkingSite/properties/side", PARKAPI_SIDES],
    ["ParkingSite/properties/parking_type", PARKAPI_KERB_POSITIONS],
    ["ParkingSite/properties/linear_parking_position", PARKAPI_LINE_POSITIONS],
  ] as const)("the bay layout crosswalk names every value at %s", ([pointer, table], { skip }) => {
    if (unavailable) skip(unavailable);
    expect(sorted(Object.keys(table))).toEqual(schema(pointer));
  });
});
