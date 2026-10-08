/**
 * Wire types close to OCPI 2.2.1 and 2.3.0, as the decoders hand them out:
 * ids are strings, numbers are numbers, nulls are absent, and times are kept
 * exactly as the publisher wrote them (some publishers send naive local time).
 */

export interface OcpiPrice {
  excl_vat: number;
  incl_vat?: number;
}

export interface OcpiDisplayText {
  language: string;
  text: string;
}

export interface OcpiBusinessDetails {
  name: string;
  website?: string;
}

export interface OcpiRegularHours {
  /** 1 is Monday, 7 is Sunday. */
  weekday: number;
  period_begin: string;
  period_end: string;
}

export interface OcpiExceptionalPeriod {
  period_begin: string;
  period_end: string;
}

export interface OcpiOpeningTimes {
  twentyfourseven: boolean;
  regular_hours?: OcpiRegularHours[];
  exceptional_openings?: OcpiExceptionalPeriod[];
  exceptional_closings?: OcpiExceptionalPeriod[];
}

export interface OcpiConnector {
  id: string;
  standard?: string;
  format?: string;
  power_type?: string;
  max_voltage?: number;
  max_amperage?: number;
  /** Watts, as OCPI defines it. */
  max_electric_power?: number;
  tariff_ids?: string[];
  terms_and_conditions?: string;
  last_updated?: string;
  /** OCPDB: the id the upstream source gave the connector. */
  original_id?: string;
}

export interface OcpiEvse {
  uid: string;
  /** The eMI3 EVSE id, as written (with or without separators). */
  evse_id?: string;
  /** Absent when the source carries no live status. `STATIC` is OCPDB's register marker. */
  status?: string;
  capabilities?: string[];
  connectors: OcpiConnector[];
  floor_level?: string;
  coordinates?: { latitude: number; longitude: number };
  physical_reference?: string;
  directions?: OcpiDisplayText[];
  parking_restrictions?: string[];
  last_updated?: string;
  status_last_updated?: string;
  /** OCPDB: the uid the upstream source gave the EVSE. */
  original_uid?: string;
}

export interface OcpiLocation {
  country_code?: string;
  party_id?: string;
  id: string;
  /** Absent when the source does not say. Only an explicit `false` withholds a location. */
  publish?: boolean;
  name?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  state?: string;
  /** ISO alpha-3 as OCPI defines it. */
  country?: string;
  coordinates: { latitude: number; longitude: number };
  parking_type?: string;
  evses: OcpiEvse[];
  directions?: OcpiDisplayText[];
  operator?: OcpiBusinessDetails;
  suboperator?: OcpiBusinessDetails;
  owner?: OcpiBusinessDetails;
  facilities?: string[];
  time_zone?: string;
  opening_times?: OcpiOpeningTimes;
  charging_when_closed?: boolean;
  last_updated?: string;
  /** OCPDB: the upstream source the aggregator took the location from. */
  source?: string;
  /** OCPDB: the id that source gave the location. */
  original_id?: string;
}

export interface OcpiPriceComponent {
  type: string;
  price: number;
  /** Percent. Absent when the VAT is unknown, which is not the same as zero. */
  vat?: number;
  step_size?: number;
}

export interface OcpiRestrictions {
  /** `HH:MM` on the location's clock. */
  start_time?: string;
  end_time?: string;
  /** `YYYY-MM-DD`. */
  start_date?: string;
  end_date?: string;
  min_kwh?: number;
  max_kwh?: number;
  min_current?: number;
  max_current?: number;
  min_power?: number;
  max_power?: number;
  /** Seconds. */
  min_duration?: number;
  max_duration?: number;
  /** `MONDAY` to `SUNDAY`. */
  day_of_week?: string[];
  reservation?: string;
}

export interface OcpiTariffElement {
  price_components: OcpiPriceComponent[];
  restrictions?: OcpiRestrictions;
}

export interface OcpiTariff {
  country_code?: string;
  party_id?: string;
  id: string;
  currency: string;
  type?: string;
  name?: string;
  tariff_alt_text?: OcpiDisplayText[];
  tariff_alt_url?: string;
  min_price?: OcpiPrice;
  max_price?: OcpiPrice;
  elements: OcpiTariffElement[];
  start_date_time?: string;
  end_date_time?: string;
  tax_included?: "YES" | "NO" | "N/A";
  last_updated?: string;
  /** OCPDB: the upstream source the aggregator took the tariff from. */
  source?: string;
  original_id?: string;
}
