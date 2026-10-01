import { defineKind, defineVocabulary, Iso8601 } from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "hazards";
const V = "1.0";

/**
 * What an alert warns of. Weather comes first, grouped as MeteoAlarm groups
 * its awareness types, then the non-weather hazards and notices of the North
 * American alerting lists (SAME, the Canadian CAP profile). `other` holds an
 * alert whose event codes name no hazard (a special weather statement, a
 * catch-all code); its CAP `event` text still says what it is.
 */
export const ALERT_TYPES = {
  wind: [
    "gust",
    "strong_wind",
    "gale",
    "storm",
    "hurricane_force",
    "extreme_wind",
    "powerline_vibration",
  ],
  thunderstorm: ["severe", "tornado", "waterspout", "squall"],
  rain: ["heavy", "persistent", "thaw"],
  snow_ice: [
    "snowfall",
    "heavy_snowfall",
    "snow_drift",
    "blizzard",
    "snow_squall",
    "winter_storm",
    "winter_weather",
    "lake_effect_snow",
    "freezing_rain",
    "freezing_drizzle",
    "ice_storm",
    "icy_surfaces",
    "black_ice",
    "flash_freeze",
  ],
  fog: ["dense", "freezing"],
  heat: ["extreme", "humid", "uv"],
  cold: ["frost", "freeze", "extreme", "wind_chill", "arctic_outflow"],
  coastal: [
    "storm_surge",
    "coastal_flood",
    "lakeshore_flood",
    "high_surf",
    "rip_current",
    "beach_hazard",
  ],
  marine: [
    "small_craft",
    "hazardous_seas",
    "freezing_spray",
    "rough_bar",
    "low_water",
    "sea_ice",
    "iceberg",
    "marine_security",
    "nautical_incident",
  ],
  tropical_cyclone: ["hurricane", "typhoon", "tropical_storm"],
  flood: ["river", "flash", "rain", "overland", "high_water", "dam_failure", "hydrologic"],
  fire: ["wildfire", "forest", "fire_weather", "urban", "industrial"],
  avalanche: [],
  dust: ["dust_storm", "blowing_dust"],
  air_quality: ["smoke", "stagnation"],
  drought: [],
  geophysical: [
    "earthquake",
    "tsunami",
    "volcano",
    "volcanic_ash",
    "landslide",
    "debris_flow",
    "lahar",
    "lava_flow",
    "pyroclastic_flow",
    "pyroclastic_surge",
    "magnetic_storm",
    "meteorite",
  ],
  hazmat: ["chemical", "biological", "radiological", "nuclear", "explosive", "falling_object"],
  civil: [
    "emergency",
    "danger",
    "evacuation",
    "shelter_in_place",
    "local_emergency",
    "law_enforcement",
    "terrorism",
    "dangerous_person",
    "dangerous_animal",
    "crime",
    "rescue",
    "public_event",
    "volunteer_request",
  ],
  missing_person: ["child_abduction", "vulnerable_person"],
  health: [
    "infectious_disease",
    "drinking_water",
    "food_supply",
    "hospital",
    "ambulance",
    "blood_supply",
    "animal_disease",
    "animal_feed",
    "plant_disease",
    "product_safety",
  ],
  utility: [
    "electricity",
    "telephone",
    "emergency_number",
    "internet",
    "cable",
    "satellite",
    "natural_gas",
    "heating_oil",
    "fuel",
    "water",
    "sewer",
    "waste",
  ],
  transport: [
    "road_closure",
    "bridge_closure",
    "road_delay",
    "road_condition",
    "traffic",
    "road_usage",
    "accident",
    "railway",
    "train_accident",
    "transit",
    "school_bus",
    "aviation",
    "airport_closure",
    "airspace_closure",
    "notam",
    "aircraft_crash",
  ],
  public_service: [
    "school_closure",
    "school_lockdown",
    "emergency_facility",
    "emergency_support",
    "facility",
  ],
  administrative: [
    "test",
    "demo",
    "message",
    "network_message",
    "reminder",
    "emergency_action",
    "national_information",
  ],
  other: [],
} as const satisfies Record<string, readonly string[]>;

const closed = (code: string, values: readonly string[], description: string) =>
  defineVocabulary({ code, values, extensible: false, description });

/** CAP 1.2's own enumerations, snake-cased; the verbatim tokens are the `cap` crosswalk. */
export const CAP_VOCABULARIES = [
  closed("cap_status", ["actual", "exercise", "system", "test", "draft"], "CAP message status."),
  closed(
    "cap_msg_type",
    ["alert", "update", "cancel", "ack", "error"],
    "What a CAP message does to the earlier messages it references.",
  ),
  closed("cap_scope", ["public", "restricted", "private"], "Who a CAP message is for."),
  closed(
    "cap_category",
    [
      "geo",
      "met",
      "safety",
      "security",
      "rescue",
      "fire",
      "health",
      "env",
      "transport",
      "infra",
      "cbrne",
      "other",
    ],
    "CAP event categories; one alert may carry several.",
  ),
  closed(
    "cap_response_type",
    [
      "shelter",
      "evacuate",
      "prepare",
      "execute",
      "avoid",
      "monitor",
      "assess",
      "all_clear",
      "none",
    ],
    "What CAP tells its audience to do.",
  ),
  closed(
    "cap_urgency",
    ["immediate", "expected", "future", "past", "unknown"],
    "How soon CAP says to act.",
  ),
  closed(
    "cap_severity",
    ["extreme", "severe", "moderate", "minor", "unknown"],
    "CAP's own severity, kept verbatim beside the situation's label.",
  ),
  closed(
    "cap_certainty",
    ["observed", "likely", "possible", "unlikely", "unknown"],
    "CAP's own certainty, kept verbatim beside the situation's.",
  ),
];

const Pair = z.strictObject({ valueName: z.string().min(1), value: z.string() });

/**
 * An alert as its CAP message states it. One situation holds one message
 * and every language of it: CAP repeats an `info` block per language, and the
 * texts that differ (`event`, `senderName`, `audience`, `contact`, headline,
 * description, instruction, area names) become `Text`. Info blocks that
 * differ in more than language are separate situations of one `groupId`.
 * The warning is in force from `effective` (CAP's default: `sent`) until
 * `expires`; the event it warns of begins at `onset`, which may lie after
 * the message expires, so it stays here. The CAP severity also sets the
 * declared label and is kept verbatim here.
 */
export const alertKind = defineKind({
  class: "situation",
  code: "alert",
  domain: DOMAIN,
  version: V,
  description:
    "A warning an authority issued as a CAP message: weather warnings, hazard, civil and public-service alerts.",
  types: ALERT_TYPES,
  details: (k) => ({
    cap: z.strictObject({
      identifier: z.string().min(1),
      sender: z.string().min(1),
      sent: Iso8601,
      status: k.vocab("cap_status"),
      msgType: k.vocab("cap_msg_type"),
      scope: k.vocab("cap_scope"),
      /** The messages this one updates, cancels or acknowledges. */
      references: z
        .array(
          z.strictObject({
            sender: z.string().min(1),
            identifier: z.string().min(1),
            sent: Iso8601,
          }),
        )
        .min(1)
        .optional(),
      /** Profiles the message follows (`IPAWSv1.0`, `profile:CAP-CP:0.4`); they say how to read its codes. */
      codes: z.array(z.string().min(1)).min(1).optional(),
      category: z.array(k.vocab("cap_category")).min(1),
      event: k.Text,
      eventCodes: z.array(Pair).min(1).optional(),
      responseType: z.array(k.vocab("cap_response_type")).min(1).optional(),
      urgency: k.vocab("cap_urgency"),
      severity: k.vocab("cap_severity"),
      certainty: k.vocab("cap_certainty"),
      audience: k.Text.optional(),
      effective: Iso8601.optional(),
      onset: Iso8601.optional(),
      /** Publisher parameters, verbatim and in order; a valueName may repeat. */
      parameters: z.array(Pair).min(1).optional(),
      web: z.url().optional(),
      senderName: k.Text.optional(),
      contact: k.Text.optional(),
    }),
  }),
});
