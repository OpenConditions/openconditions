import type { PinnedSet } from "../pinned.js";

/**
 * Fintraffic's Digitraffic road API: its OpenAPI 3.0.1 document, served at
 * https://tie.digitraffic.fi/swagger/openapi.json and linked as the API's
 * specification from https://www.digitraffic.fi/en/road-traffic/. It
 * defines the weather stations (`WeatherStationPropertiesSimpleV1` and its
 * detailed form: `state`, `collectionStatus`), their sensor values
 * (`SensorValueDtoV1.reliability`), the weather cameras
 * (`WeathercamStationProperties*`, `WeathercamPresetDirectionV1`) and the
 * maintenance tracking (`MaintenanceTrackingLatestPropertiesV1.tasks`).
 * Published under CC BY 4.0 (https://www.digitraffic.fi/en/terms-of-service/).
 * The service replaces the document with every release, so it is fetched
 * from the Internet Archive's capture of 2026-01-13 (release 2026.1.12-1).
 * Retrieved 2026-10-17, when the service served release 2026.10.14-1: every
 * enumeration of the weather station, sensor value, weather camera and
 * maintenance tracking schemas is the same in both. A release then never
 * fails the check, and moving to a new one is a deliberate re-pin.
 */
export const DIGITRAFFIC_ROAD: PinnedSet = {
  id: "digitraffic-road-2026.1.12-1",
  files: [
    {
      name: "openapi.json",
      url: "https://web.archive.org/web/20260113123836id_/https://tie.digitraffic.fi/swagger/openapi.json",
      sha256: "25e95d54003ed5205c53bb62974711effa587b053c071a9910f2c7eabd5b1a09",
    },
  ],
};
