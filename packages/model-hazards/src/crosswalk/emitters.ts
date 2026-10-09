import { ALERT_TYPES } from "../alerts.js";

/** Alert types that warn of weather, the rest being civil, public-service and other notices. */
const WEATHER_ALERT_TYPES = new Set([
  "wind",
  "thunderstorm",
  "rain",
  "snow_ice",
  "fog",
  "heat",
  "cold",
  "coastal",
  "marine",
  "tropical_cyclone",
  "flood",
  "avalanche",
  "dust",
  "drought",
]);

/**
 * Hazards classification → Road511/NAPSPAN feature type, for consumers
 * migrating from those APIs, which list weather alerts, other alerts,
 * wildfires and fire perimeters as separate feature types.
 */
export const ROAD511_HAZARD_TYPES: Readonly<Record<string, string | null>> = {
  ...Object.fromEntries(
    Object.keys(ALERT_TYPES).map((t) => [
      `alert.${t}`,
      WEATHER_ALERT_TYPES.has(t) ? "weather_alerts" : "alerts",
    ]),
  ),
  "natural_hazard.wildfire": "wildfires",
  "natural_hazard.wildfire.wildfire_perimeter": "wildfire_perimeters",
  "natural_hazard.wildfire.prescribed_burn": "wildfire_perimeters",
  "natural_hazard.flood": null,
  "natural_hazard.smoke": null,
  "natural_hazard.landslide": null,
  "natural_hazard.avalanche": null,
  "natural_hazard.earthquake": null,
  "natural_hazard.volcanic_ash": null,
  "natural_hazard.dust_storm": null,
  "natural_hazard.tropical_cyclone": null,
  "natural_hazard.volcano": null,
  "natural_hazard.drought": null,
  "natural_hazard.sea_ice": null,
};

/**
 * Natural hazards → GTFS-Realtime `Alert.Cause`. GTFS-Realtime files every
 * natural cause under WEATHER except the ones no weather causes; alerts carry
 * no cause of their own (the transit agency's alert does).
 */
export const GTFS_RT_HAZARD_CAUSES: Readonly<Record<string, string | null>> = {
  "natural_hazard.wildfire": "WEATHER",
  "natural_hazard.flood": "WEATHER",
  "natural_hazard.smoke": "WEATHER",
  "natural_hazard.landslide": "WEATHER",
  "natural_hazard.avalanche": "WEATHER",
  "natural_hazard.earthquake": "OTHER_CAUSE",
  "natural_hazard.volcanic_ash": "OTHER_CAUSE",
  "natural_hazard.dust_storm": "WEATHER",
  "natural_hazard.tropical_cyclone": "WEATHER",
  "natural_hazard.volcano": "OTHER_CAUSE",
  "natural_hazard.drought": "WEATHER",
  "natural_hazard.sea_ice": "WEATHER",
};
