import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
  // A station the ministry publishes at 0,0: it has not located it.
  "fuel/minetur": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        Fecha: "31/07/2026 13:55:02",
        ResultadoConsulta: "OK",
        ListaEESSPrecio: [
          {
            IDEESS: "1",
            Latitud: "40,416775",
            "Longitud (WGS84)": "-3,703790",
            "Precio Gasoleo A": "1,529",
          },
          { IDEESS: "2", Latitud: "0,000000", "Longitud (WGS84)": "0,000000" },
        ],
      }),
    },
  },
  // A station without a position in the export.
  "fuel/prix-carburants": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify([
        { id: 1, geom: { lon: 2.35, lat: 48.85 }, gazole_prix: 1.799 },
        { id: 2, geom: null, gazole_prix: 1.799 },
      ]),
    },
  },
  // A station listed without its coordinates.
  "fuel/tankerkoenig": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        ok: true,
        stations: [
          { id: "a", lat: 52.52, lng: 13.4, diesel: 1.659 },
          { id: "b", lat: null, lng: null, diesel: 1.659 },
        ],
      }),
    },
  },
  // A price of a fuel type the calculator did not offer before.
  "fuel/econtrol": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify([
        {
          id: 1,
          location: { latitude: 48.2, longitude: 16.37 },
          prices: [
            { fuelType: "DIE", amount: 1.659 },
            { fuelType: "SUPPLUS", amount: 1.899 },
          ],
        },
      ]),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
