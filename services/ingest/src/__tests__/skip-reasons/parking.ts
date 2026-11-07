import { parkregAcquisitionHash } from "@openconditions/parking";
import { repoFeed } from "../helpers/catalog.js";
import type { SkipExemptions, SkipSamples } from "./sample.js";

const national = repoFeed("no-vegvesen-parking");

const json = (value: unknown) => JSON.stringify(value);

export const SAMPLES: SkipSamples = {
  "parking/vegvesen-parkreg": {
    reason: "unknown_value",
    feed: {
      ...national,
      parkreg: { qualified: true, acquisitionSha256: parkregAcquisitionHash(national) },
    },
    payloads: {
      inventory: json([{ id: 1 }]),
      main: json([
        {
          id: 1,
          breddegrad: 59.9,
          lengdegrad: 10.7,
          deaktivert: null,
          aktivVersjon: {
            versjonsnummer: 1,
            aktiveringstidspunkt: "2026-01-01T00:00:00Z",
            sluttidspunkt: null,
            antallAvgiftsbelagtePlasser: 7,
            antallAvgiftsfriePlasser: 3,
            antallForflytningshemmede: 0,
            antallLadeplasser: 0,
            typeParkeringsomrade: "LANGS_KJOREBANE",
            innfartsparkering: "NEW",
          },
        },
      ]),
    },
  },
  // A facility whose address carries no location.
  "parking/db-bahnpark": {
    reason: "no_geometry",
    payloads: {
      main: json([
        {
          id: 1,
          type: { name: "Parkhaus" },
          address: { location: { latitude: 50.1, longitude: 8.6 } },
        },
        { id: 2, type: { name: "Parkhaus" }, address: { location: null } },
      ]),
    },
  },
  // A garage area without a point.
  "parking/rdw": {
    reason: "no_geometry",
    payloads: {
      specs: json([]),
      areas: json([
        {
          areamanagerid: "100",
          areaid: "G1",
          location: { latitude: "52.37", longitude: "4.89" },
          usageid: "GARAGEP",
        },
        { areamanagerid: "100", areaid: "G2", usageid: "GARAGEP" },
      ]),
    },
  },
  // A car facility with a null geometry.
  "parking/sbb": {
    reason: "no_geometry",
    payloads: {
      main: json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "a",
            geometry: { type: "Point", coordinates: [7.4, 46.9] },
            properties: { parkingFacilityCategory: "CAR" },
          },
          {
            type: "Feature",
            id: "b",
            geometry: null,
            properties: { parkingFacilityCategory: "CAR" },
          },
        ],
      }),
    },
  },
  // A station without coordinates.
  "parking/opendatahub": {
    reason: "no_geometry",
    payloads: {
      sites: json({
        data: [
          { scode: "A", sname: "A", scoordinate: { x: 11.34, y: 46.5, srid: 4326 } },
          { scode: "B", sname: "B", scoordinate: { x: null, y: null, srid: 4326 } },
        ],
      }),
      status: json({ data: [] }),
    },
  },
  // A car park without SVY21 coordinates.
  "parking/hdb": {
    reason: "no_geometry",
    payloads: {
      sites: json({
        result: {
          records: [
            {
              car_park_no: "ACB",
              address: "BLK 1",
              x_coord: "30314.7936",
              y_coord: "31490.4942",
              car_park_type: "SURFACE CAR PARK",
            },
            { car_park_no: "BBB", address: "BLK 2", x_coord: "", y_coord: "" },
          ],
        },
      }),
      status: json({ items: [{ carpark_data: [] }] }),
    },
  },
  // A car park state the format does not know; the car park and its counts are kept.
  "parking/utmc": {
    reason: "unknown_value",
    payloads: {
      sites: json([
        {
          systemCodeNumber: "CP1",
          definitions: [
            { shortDescription: "Town Centre", point: { latitude: 54.97, longitude: -1.62 } },
          ],
          configurations: [{ capacity: 200 }],
        },
      ]),
      status: json([
        {
          systemCodeNumber: "CP1",
          dynamics: [
            { occupancy: 10, stateDescription: "MAINTENANCE", lastUpdated: "2026-07-31T11:55:00Z" },
          ],
        },
      ]),
    },
  },
  // A car park entry without a location.
  "parking/tfnsw": {
    reason: "no_geometry",
    payloads: {
      main: json([
        {
          facility_id: "26",
          spots: "100",
          location: { latitude: "-33.69", longitude: "150.90" },
          occupancy: { total: "10" },
          MessageDate: "2026-07-31T22:00:00",
        },
        { facility_id: "27", spots: "100", location: { suburb: "Tallawong" } },
      ]),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
