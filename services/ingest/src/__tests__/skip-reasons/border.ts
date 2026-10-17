import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
  // A port stating a wait that the crossing table cannot place.
  "border/cbp-bwt": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify([
        {
          port_number: "999999",
          port_name: "Nowhere",
          crossing_name: "",
          port_status: "Open",
          passenger_vehicle_lanes: {
            maximum_lanes: "4",
            standard_lanes: {
              operational_status: "delay",
              update_time: "At 7:00 am EDT",
              delay_minutes: "10",
              lanes_open: "2",
            },
          },
        },
      ]),
    },
  },
  // An office the crossing table cannot place.
  "border/cbsa-bwt": {
    reason: "no_geometry",
    payloads: {
      main: [
        "Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Travellers Flow - Canada bound;;",
        "Nowhere;; Nowhere, QC;; 2026-07-31 07:55 EDT;; No Delay;; 5 minutes;; ",
      ].join("\n"),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
