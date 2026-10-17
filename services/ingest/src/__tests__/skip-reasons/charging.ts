import type { SkipExemptions, SkipSamples } from "./sample.js";

const json = (value: unknown) => JSON.stringify(value);

export const SAMPLES: SkipSamples = {
  // An EVSE record without coordinates, beside a placed one.
  "charging/oicp": {
    reason: "no_geometry",
    payloads: {
      main: json({
        EVSEData: [
          {
            OperatorID: "DE*ABC",
            EVSEDataRecord: [
              {
                EvseID: "DE*ABC*E1",
                Plugs: ["Type 2 Outlet"],
                GeoCoordinates: { DecimalDegree: { Latitude: "47.37", Longitude: "8.54" } },
              },
              { EvseID: "DE*ABC*E2", Plugs: ["Type 2 Outlet"] },
            ],
          },
        ],
      }),
    },
  },
  // A location feature with a null geometry.
  "charging/digitraffic": {
    reason: "no_geometry",
    payloads: {
      main: json({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { id: "L1", evses: [] } }],
      }),
    },
  },
  // A register row without coordinates.
  "charging/bnetza": {
    reason: "no_geometry",
    payloads: {
      main: "Ladeeinrichtungs-ID;Betreiber;Breitengrad;Längengrad\r\n1;Stadtwerke Beispiel;;\r\n",
    },
  },
  // An electric station whose coordinates are null.
  "charging/afdc": {
    reason: "no_geometry",
    payloads: {
      main: json({
        fuel_stations: [{ id: 1, fuel_type_code: "ELEC", latitude: null, longitude: null }],
      }),
    },
  },
  // A station without a position.
  "charging/nobil": {
    reason: "no_geometry",
    payloads: {
      main: json({ chargerstations: [{ csmd: { id: 1, International_id: "NOR_00001" } }] }),
    },
  },
  // A pool with an electric station, neither of them placed.
  "charging/eipa": {
    reason: "no_geometry",
    payloads: {
      pools: json({ data: [{ id: 1, name: "Pool" }] }),
      stations: json({ data: [{ id: 10, pool_id: 1, type: "E" }] }),
      points: json({ data: [] }),
    },
  },
  // A charging point without a location.
  "charging/cynap": {
    reason: "no_geometry",
    payloads: {
      main:
        "<d2LogicalModel><payload><energyInfrastructureTable><energyInfrastructureTablePublication>" +
        "<chargingPoints><chargingPoint><chargingPointIdentification>CY-1</chargingPointIdentification>" +
        "</chargingPoint></chargingPoints>" +
        "</energyInfrastructureTablePublication></energyInfrastructureTable></payload></d2LogicalModel>",
    },
  },
  // A connector reporting a state outside the OCPP states.
  "charging/chargy": {
    reason: "unknown_value",
    payloads: {
      main:
        "<kml><Document><Placemark><name>Site</name><Point><coordinates>6.13,49.61</coordinates></Point>" +
        '<ExtendedData><Data name="chargingdevice"><value>' +
        '{"id":1,"connectors":[{"id":11,"description":"HOVERING"}]}' +
        "</value></Data></ExtendedData></Placemark></Document></kml>",
    },
  },
  // A site whose geometry is null.
  "charging/evroam": {
    reason: "no_geometry",
    payloads: {
      main: json({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { name: "Site" } }],
      }),
    },
  },
  // A charger of a type code the API does not list.
  "charging/keco": {
    reason: "unknown_value",
    payloads: {
      main: json({
        response: {
          body: {
            items: {
              item: [{ statId: "ME1", chgerId: "01", lat: "37.5", lng: "127.0", chgerType: "99" }],
            },
          },
        },
      }),
    },
  },
  // A location without coordinates.
  "charging/lta": {
    reason: "no_geometry",
    payloads: { main: json({ value: [{ locationId: "L1", name: "Site" }] }) },
  },
  // A station without a position.
  "charging/tdx": {
    reason: "no_geometry",
    payloads: { sites: json({ Stations: [{ StationID: "S1" }] }) },
  },
  // A POI whose address carries no coordinates.
  "charging/ocm": {
    reason: "no_geometry",
    payloads: { main: json([{ ID: 1, AddressInfo: { Title: "Site" } }]) },
  },
};

export const EXEMPT: SkipExemptions = {};
