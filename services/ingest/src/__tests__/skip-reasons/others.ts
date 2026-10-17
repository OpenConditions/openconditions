import type { SkipSamples } from "./sample.js";

/** Samples of the formats whose parsers record their skips. */
export const SAMPLES: SkipSamples = {
  "parking/parkapi-v3": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({ items: [{ id: 1, source_id: 1, name: "P1" }] }),
      sources: JSON.stringify({ items: [{ id: 1, uid: "source" }] }),
    },
  },
  "hazards/cap": {
    reason: "malformed",
    payloads: {
      // An alert with no info block names no hazard.
      alerts: [
        `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>A1</identifier><sender>skipgate</sender><sent>2026-07-31T10:00:00+00:00</sent>
  <status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
</alert>`,
      ],
    },
  },
  "hazards/nws": {
    reason: "malformed",
    payloads: { alerts: JSON.stringify({ features: [{ type: "Feature", geometry: null }] }) },
  },
  "hazards/meteoalarm": {
    reason: "malformed",
    payloads: { alerts: JSON.stringify({ warnings: [{ uuid: "no-alert" }] }) },
  },
  "hazards/gdacs": {
    reason: "unknown_type",
    payloads: {
      events: `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:gdacs="http://www.gdacs.org"><channel>
  <item><gdacs:eventtype>XX</gdacs:eventtype><gdacs:eventid>1</gdacs:eventid></item>
  <item><gdacs:eventtype>EQ</gdacs:eventtype><gdacs:eventid>2</gdacs:eventid></item>
</channel></rss>`,
    },
  },
  "charging/irve": {
    reason: "no_geometry",
    payloads: {
      main: "id_pdc_itinerance,id_station_itinerance,coordonneesXY\nFRA68E680210015,FRA68P68021001,\n",
    },
  },
  "charging/ocpi": {
    reason: "no_geometry",
    payloads: { main: JSON.stringify([{ id: "L1", evses: [] }]) },
  },
  "roads/datex2": {
    reason: "no_geometry",
    payloads: {
      main: `<?xml version="1.0" encoding="UTF-8"?>
<d2:payloadPublication xmlns:d2="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="d2:SituationPublication">
  <d2:situation id="S1"><d2:situationRecord xsi:type="d2:Accident" id="R1">
    <d2:situationRecordCreationTime>2026-07-31T00:00:00Z</d2:situationRecordCreationTime>
    <d2:validity><d2:validityStatus>active</d2:validityStatus></d2:validity>
    <d2:groupOfLocations xsi:type="d2:AlertCLinear"><d2:alertCLocationCountryCode>de</d2:alertCLocationCountryCode></d2:groupOfLocations>
  </d2:situationRecord></d2:situation>
</d2:payloadPublication>`,
    },
  },
  "roads/wzdx": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            id: "no-geo",
            type: "Feature",
            properties: { core_details: { event_type: "work-zone" } },
            geometry: null,
          },
        ],
      }),
    },
  },
  "roads/datex2-measured": {
    reason: "no_geometry",
    payloads: {
      main: `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
  <siteMeasurements>
    <measurementSiteReference id="unknown-site" version="1"/>
    <measurementTimeDefault>2026-07-31T11:55:00Z</measurementTimeDefault>
    <measuredValue index="1"><measuredValue><basicData><averageVehicleSpeed numberOfInputValuesUsed="4"><speed>80</speed></averageVehicleSpeed></basicData></measuredValue></measuredValue>
  </siteMeasurements>
</payloadPublication></d2LogicalModel>`,
    },
  },
  "cameras/datex2": {
    reason: "no_geometry",
    payloads: {
      main: `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://levelC/schema/3/d2Payload" xmlns:ns2="http://levelC/schema/3/faultAndStatus" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns2:DevicePublication">
  <ns2:device id="1"><ns2:typeOfDevice>camera</ns2:typeOfDevice></ns2:device>
</d2:payload>`,
    },
  },
  "charging/datex2": {
    reason: "no_geometry",
    payloads: {
      main: `<?xml version="1.0" encoding="UTF-8"?>
<EnergyInfrastructureTablePublication>
  <energyInfrastructureTable><energyInfrastructureSite id="S1"/></energyInfrastructureTable>
</EnergyInfrastructureTablePublication>`,
    },
  },
  "parking/datex2": {
    reason: "no_geometry",
    payloads: {
      sites: `<?xml version="1.0" encoding="UTF-8"?>
<ParkingTablePublication>
  <parkingTable><parkingRecord id="P1"/></parkingTable>
</ParkingTablePublication>`,
      status: [],
    },
  },
  "parking/datex2-light": {
    reason: "no_geometry",
    payloads: { main: JSON.stringify([{ id: "P1" }]) },
  },
};
