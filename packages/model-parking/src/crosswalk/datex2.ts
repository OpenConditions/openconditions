import type { SourceTable, TargetTable } from "@openconditions/model";

/**
 * DATEX II parking codes → OpenConditions classifications and vocabulary
 * values. Source codes are prefixed with the enumeration they come from
 * (`structureType:onStreet`), because one code means different things in
 * different DATEX enumerations and a crosswalk is keyed by the code alone.
 */

/** What a site is, structurally: the one classification a `type` carries. */
export const DATEX2_V3_PARKING_TYPES: SourceTable = {
  "structureType:onStreet": "parking_site.on_street",
  "structureType:offStreetSurface": "parking_site.off_street",
  "structureType:offStreetStructure": "parking_site.off_street",
  "structureType:_extended": null,
  "usageScenario:truckParking": "parking_site.truck_parking",
  "usageScenario:parkAndRide": "parking_site.park_and_ride",
  "usageScenario:restArea": "parking_site.rest_area_parking",
  "usageScenario:serviceArea": "parking_site.rest_area_parking",
  "usageScenario:motorwayParking": "parking_site.rest_area_parking",
  "usageScenario:nearbyMotorwayParking": "parking_site.rest_area_parking",
  // Usages, not structures: they land in `details.usage[]` and leave the type to the layout.
  "usageScenario:automatedParkingGarage": null,
  "usageScenario:carSharing": null,
  "usageScenario:delivery": null,
  "usageScenario:dropOff": null,
  "usageScenario:dropOffMechanical": null,
  "usageScenario:dropOffWithValet": null,
  "usageScenario:eventParking": null,
  "usageScenario:guidanceToAvailableSpaces": null,
  "usageScenario:kissAndRide": null,
  "usageScenario:liftshare": null,
  "usageScenario:overnightParking": null,
  "usageScenario:parkAndCycle": null,
  "usageScenario:parkAndDrive": null,
  "usageScenario:parkAndWalk": null,
  "usageScenario:poiParking": null,
  "usageScenario:specialLocation": null,
  "usageScenario:staffGuidesToSpace": null,
  "usageScenario:vehicleLift": null,
  "usageScenario:zone": null,
  "usageScenario:other": null,
  "usageScenario:_extended": null,
};

export const DATEX2_V2_PARKING_TYPES: SourceTable = {
  "urbanParkingSiteType:onStreetParking": "parking_site.on_street",
  "urbanParkingSiteType:offStreetParking": "parking_site.off_street",
  "urbanParkingSiteType:other": null,
  "interUrbanParkingSiteLocation:motorway": "parking_site.rest_area_parking",
  "interUrbanParkingSiteLocation:nearbyMotorway": "parking_site.rest_area_parking",
  "interUrbanParkingSiteLocation:layBy": "parking_site.rest_area_parking",
  "interUrbanParkingSiteLocation:onStreet": "parking_site.on_street",
  "interUrbanParkingSiteLocation:other": null,
  "usageScenario:truckParking": "parking_site.truck_parking",
  "usageScenario:parkAndRide": "parking_site.park_and_ride",
  "usageScenario:restArea": "parking_site.rest_area_parking",
  "usageScenario:serviceArea": "parking_site.rest_area_parking",
  "usageScenario:parkAndCycle": null,
  "usageScenario:parkAndWalk": null,
  "usageScenario:kissAndRide": null,
  "usageScenario:liftshare": null,
  "usageScenario:carSharing": null,
  "usageScenario:dropOffWithValet": null,
  "usageScenario:dropOffMechanical": null,
  "usageScenario:eventParking": null,
  "usageScenario:automaticParkingGuidance": null,
  "usageScenario:staffGuidesToSpace": null,
  "usageScenario:vehicleLift": null,
  "usageScenario:loadingBay": null,
  "usageScenario:dropOff": null,
  "usageScenario:overnightParking": null,
  "usageScenario:unknown": null,
  "usageScenario:other": null,
};

/** The emitter's code for each of our types; DATEX needs the structure, not the usage. */
export const DATEX2_V3_PARKING_TYPES_OUT: TargetTable = {
  "parking_site.on_street": "structureType:onStreet",
  "parking_site.off_street": "structureType:offStreetStructure",
  "parking_site.park_and_ride": "usageScenario:parkAndRide",
  "parking_site.truck_parking": "usageScenario:truckParking",
  "parking_site.rest_area_parking": "usageScenario:restArea",
};

/**
 * Whether a site is open and whether it has room. DATEX II v3 splits this
 * across an opening status, an operation status and a place status, and none
 * of the three answers both questions on its own; v2 answers both with one
 * enumeration, which is what the Dutch and Luxembourgish feeds publish.
 */
export const DATEX2_V3_PARKING_STATUSES: SourceTable = {
  "openingStatus:open": "open",
  "openingStatus:openWithServiceLimitation": "open",
  "openingStatus:closed": "closed",
  "openingStatus:closedOnHoliday": "closed",
  "openingStatus:closedOnMaintenance": "closed_abnormally",
  "openingStatus:temporarilyClosed": "closed_abnormally",
  "openingStatus:statusUnknown": "unknown",
  "openingStatus:other": "unknown",
  "openingStatus:_extended": null,
  "operationStatus:inOperation": "open",
  "operationStatus:limitedOperation": "open",
  "operationStatus:notInOperation": "closed",
  "operationStatus:notInOperationAbnormal": "closed_abnormally",
  "operationStatus:technicalDefect": "closed_abnormally",
  "operationStatus:unknown": "unknown",
  "operationStatus:_extended": null,
  "placeStatus:full": "full",
  "placeStatus:fullAtEntrance": "full",
  "placeStatus:spacesAvailable": "spaces_available",
  "placeStatus:almostFull": "almost_full",
  "placeStatus:overcrowding": "full",
  "placeStatus:overcrowdingLevel1": "almost_full",
  "placeStatus:overcrowdingLevel2": "full",
  "placeStatus:noOvercrowding": "spaces_available",
  "placeStatus:unknown": "unknown",
  "placeStatus:other": "unknown",
  "placeStatus:_extended": null,
};

export const DATEX2_V2_PARKING_STATUSES: SourceTable = {
  "parkingSiteStatus:spacesAvailable": "spaces_available",
  "parkingSiteStatus:almostFull": "almost_full",
  "parkingSiteStatus:fullAtEntrance": "full",
  "parkingSiteStatus:full": "full",
  "parkingSiteStatus:unknown": "unknown",
  "parkingSiteStatus:other": "unknown",
  "overcrowdingStatus:overcrowding": "full",
  "overcrowdingStatus:overcrowdingLevel1": "almost_full",
  "overcrowdingStatus:overcrowdingLevel2": "full",
  "overcrowdingStatus:noOvercrowding": "spaces_available",
  "overcrowdingStatus:unknown": "unknown",
  "overcrowdingStatus:other": "unknown",
  "vacantSpaces:noParkingSpacesAvailable": "full",
  "vacantSpaces:expectNoSpacesAvailable": "almost_full",
  "vacantSpaces:onlyAFewSpacesAvailable": "almost_full",
  "vacantSpaces:lessThan10SpacesAvailable": "spaces_available",
  "vacantSpaces:lessThan20SpacesAvailable": "spaces_available",
  "vacantSpaces:lessThan30SpacesAvailable": "spaces_available",
  "vacantSpaces:lessThan40SpacesAvailable": "spaces_available",
  "vacantSpaces:lessThan50SpacesAvailable": "spaces_available",
  "vacantSpaces:unknown": "unknown",
  "vacantSpaces:other": "unknown",
};

export const DATEX2_V3_PARKING_STATUSES_OUT: TargetTable = {
  open: "openingStatus:open",
  closed: "openingStatus:closed",
  closed_abnormally: "openingStatus:temporarilyClosed",
  full: "placeStatus:full",
  almost_full: "placeStatus:almostFull",
  spaces_available: "placeStatus:spacesAvailable",
  unknown: "placeStatus:unknown",
};

/** v2 answers both questions with one enumeration, so two of our values have no code. */
export const DATEX2_V2_PARKING_STATUSES_OUT: TargetTable = {
  spaces_available: "parkingSiteStatus:spacesAvailable",
  almost_full: "parkingSiteStatus:almostFull",
  full: "parkingSiteStatus:full",
  unknown: "parkingSiteStatus:unknown",
  open: null,
  closed: null,
  closed_abnormally: null,
};

/** Which way occupancy is moving. The graded values collapse: a trend has no speed. */
export const DATEX2_V3_PARKING_TRENDS: SourceTable = {
  decreasing: "clearing",
  decreasingQuickly: "clearing",
  decreasingSlowly: "clearing",
  increasing: "filling",
  increasingQuickly: "filling",
  increasingSlowly: "filling",
  stable: "steady",
  unknown: null,
  other: null,
  _extended: null,
};

export const DATEX2_V2_PARKING_TRENDS: SourceTable = {
  decreasing: "clearing",
  decreasingQuickly: "clearing",
  decreasingSlowly: "clearing",
  increasing: "filling",
  increasingQuickly: "filling",
  increasingSlowly: "filling",
  stable: "steady",
  unknown: null,
  other: null,
};

export const DATEX2_PARKING_TRENDS_OUT: TargetTable = {
  filling: "increasing",
  clearing: "decreasing",
  steady: "stable",
  rising: null,
  falling: null,
};

/** The measured values of a parking status record → our properties. */
export const DATEX2_PARKING_MEASURES: SourceTable = {
  "ParkingOccupancy/parkingNumberOfVacantSpaces": "parking.available",
  "ParkingOccupancy/parkingNumberOfOccupiedSpaces": "parking.occupied",
  "ParkingOccupancy/parkingOccupancy": "parking.occupancy_pct",
  "Occupancy/numberOfVacantSpaces": "parking.available",
  "Occupancy/numberOfOccupiedSpaces": "parking.occupied",
  "Occupancy/occupancy": "parking.occupancy_pct",
  // Graded and thresholded counts are the same measurement in bands; a band is
  // not a count, and `parking.status` already carries what the bands say.
  "Occupancy/numberOfVacantSpacesGraded": null,
  "Occupancy/numberOfVacantSpacesHigherThan": null,
  "Occupancy/numberOfVacantSpacesLowerThan": null,
  "Occupancy/occupancyGraded": null,
  "Occupancy/occupancyChange": null,
  "Occupancy/changeOfOccupiedSpaces": null,
  "Occupancy/lastMaximumOccupancy": null,
};

export const DATEX2_PARKING_MEASURES_OUT: TargetTable = {
  "parking.available": "ParkingOccupancy/parkingNumberOfVacantSpaces",
  "parking.occupied": "ParkingOccupancy/parkingNumberOfOccupiedSpaces",
  "parking.occupancy_pct": "ParkingOccupancy/parkingOccupancy",
  "parking.status": null,
  "parking.trend": null,
};

/**
 * What a site offers. DATEX II v2 splits it in two — a service facility is
 * staffed, a piece of equipment is not — and both lists reach OpenConditions
 * as amenities. The spellings are the schema's, typos included
 * (`informatonStele`, `fireExtingiusher`).
 */
export const DATEX2_V2_FACILITIES: SourceTable = {
  "serviceFacilityType:hotel": "hotel",
  "serviceFacilityType:motel": "motel",
  "serviceFacilityType:overnightAccommodation": "overnight_accommodation",
  "serviceFacilityType:shop": "shop",
  "serviceFacilityType:kiosk": "kiosk",
  "serviceFacilityType:foodShopping": "food_shopping",
  "serviceFacilityType:cafe": "cafe",
  "serviceFacilityType:restaurant": "restaurant",
  "serviceFacilityType:restaurantSelfService": "self_service_restaurant",
  "serviceFacilityType:motorwayRestaurant": "motorway_restaurant",
  "serviceFacilityType:motorwayRestaurantSmall": "motorway_restaurant",
  "serviceFacilityType:sparePartsShopping": "spare_parts_shop",
  "serviceFacilityType:petrolStation": "petrol_station",
  "serviceFacilityType:vehicleMaintenance": "vehicle_maintenance",
  "serviceFacilityType:tyreRepair": "tyre_repair",
  "serviceFacilityType:truckRepair": "truck_repair",
  "serviceFacilityType:truckWash": "truck_wash",
  "serviceFacilityType:carWash": "car_wash",
  "serviceFacilityType:pharmacy": "pharmacy",
  "serviceFacilityType:medicalFacility": "medical_facility",
  "serviceFacilityType:police": "police",
  "serviceFacilityType:touristInformation": "tourist_information",
  "serviceFacilityType:bikeSharing": "bike_sharing",
  "serviceFacilityType:docstop": "docstop",
  "serviceFacilityType:laundry": "laundry",
  "serviceFacilityType:leisureActivities": "leisure",
  "serviceFacilityType:unknown": null,
  "serviceFacilityType:other": null,
  "equipmentType:toilet": "toilets",
  "equipmentType:shower": "shower",
  "equipmentType:informationPoint": "information_point",
  "equipmentType:informatonStele": "information_point",
  "equipmentType:internetTerminal": "internet_terminal",
  "equipmentType:internetWireless": "wifi",
  "equipmentType:payDesk": "payment_machine",
  "equipmentType:paymentMachine": "payment_machine",
  "equipmentType:cashMachine": "cash_machine",
  "equipmentType:vendingMachine": "vending_machine",
  "equipmentType:safeDeposit": "safe_deposit",
  "equipmentType:luggageLocker": "luggage_locker",
  "equipmentType:publicPhone": "public_phone",
  "equipmentType:publicCoinPhone": "public_phone",
  "equipmentType:publicCardPhone": "public_phone",
  "equipmentType:elevator": "elevator",
  "equipmentType:picnicFacilities": "picnic_facilities",
  "equipmentType:dumpingStation": "dumping_station",
  "equipmentType:freshWater": "fresh_water",
  "equipmentType:wasteDisposal": "waste_disposal",
  "equipmentType:refuseBin": "refuse_bin",
  "equipmentType:playground": "playground",
  "equipmentType:electricChargingStation": "charging_station",
  "equipmentType:bikeParking": "bike_parking",
  "equipmentType:tollTerminal": "toll_terminal",
  "equipmentType:defibrillator": "defibrillator",
  "equipmentType:firstAidEquipment": "first_aid",
  "equipmentType:fireExtingiusher": "fire_extinguisher",
  "equipmentType:fireHydrant": "fire_hydrant",
  // Not amenities: fax and copying are office services no consumer filters on,
  // a fire hose is part of the building, and the rest say nothing is offered.
  "equipmentType:faxMachineOrService": null,
  "equipmentType:copyMachineOrService": null,
  "equipmentType:fireHose": null,
  "equipmentType:iceFreeScaffold": null,
  "equipmentType:none": null,
  "equipmentType:unknown": null,
  "equipmentType:other": null,
};

export const DATEX2_V3_FACILITIES: SourceTable = {
  "facilityType:airport": "airport",
  "facilityType:carPark": "parking",
  "facilityType:carRentalStation": "car_rental",
  "facilityType:electricChargingStation": "charging_station",
  "facilityType:energyInfrastructureSite": "charging_station",
  "facilityType:lorryParkingSite": "parking",
  "facilityType:parkingSite": "parking",
  "facilityType:petrolStation": "petrol_station",
  "facilityType:publicTransportDepot": "public_transport_hub",
  "facilityType:publicTransportHub": "public_transport_hub",
  "facilityType:shoppingCentre": "mall",
  "facilityType:trainStation": "train_station",
  "facilityType:other": null,
  "facilityType:_extended": null,
};

/** What a site does to be secure. Both DATEX versions publish the same list. */
export const DATEX2_PARKING_SECURITY: SourceTable = {
  socialControl: "social_control",
  securityStaff: "security_staff",
  externalSecurity: "external_security",
  cctv: "cctv",
  dog: "dog",
  guard24hours: "guard_24h",
  lighting: "lighting",
  floodLight: "flood_light",
  fences: "fences",
  areaSeperatedFromSurroundings: "separated_area",
  none: "none",
  unknown: null,
  other: null,
  _extended: null,
};

export const DATEX2_PARKING_SECURITY_OUT: TargetTable = {
  social_control: "socialControl",
  security_staff: "securityStaff",
  external_security: "externalSecurity",
  cctv: "cctv",
  dog: "dog",
  guard_24h: "guard24hours",
  lighting: "lighting",
  flood_light: "floodLight",
  fences: "fences",
  separated_area: "areaSeperatedFromSurroundings",
  none: "none",
};

/** How closely a site is watched; v2 and v3 publish the same list. */
export const DATEX2_PARKING_SUPERVISION: Readonly<Record<string, string | null>> = {
  remote: "remote",
  onSite: "on_site",
  controlCentreOnSite: "control_centre",
  controlCentreOffSite: "control_centre",
  patrol: "patrol",
  none: "none",
  unknown: "unknown",
  other: null,
  _extended: null,
};
