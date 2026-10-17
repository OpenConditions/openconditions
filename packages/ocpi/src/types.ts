/**
 * Wire types close to OCPI 2.2.1 and 2.3.0, as the decoders hand them out:
 * ids are strings, numbers are numbers, nulls are absent, and times are kept
 * exactly as the publisher wrote them (some publishers send naive local time).
 */

/**
 * A 2.2.1 `Price`; a 2.3.0 `PriceLimit` (`before_taxes`, `after_taxes`) is
 * read into the same two amounts.
 */
export interface OcpiPrice {
  excl_vat: number;
  incl_vat?: number;
}

export interface OcpiDisplayText {
  language: string;
  text: string;
}

export interface OcpiImage {
  url: string;
  thumbnail?: string;
  /** `CHARGER`, `ENTRANCE`, `LOCATION`, `NETWORK`, `OPERATOR`, `OTHER` or `OWNER`, upper-cased. */
  category?: string;
  /** The file type (`jpeg`, `png`). */
  type?: string;
  width?: number;
  height?: number;
}

export interface OcpiBusinessDetails {
  name: string;
  website?: string;
  logo?: OcpiImage;
}

export interface OcpiGeoPoint {
  latitude: number;
  longitude: number;
}

export interface OcpiAdditionalGeoLocation extends OcpiGeoPoint {
  name?: OcpiDisplayText;
}

export interface OcpiStatusSchedule {
  period_begin: string;
  period_end?: string;
  /** Upper-cased. */
  status: string;
}

/** 2.3.0 `EVSEParking`: a parking place an EVSE serves, and where the EVSE stands beside it. */
export interface OcpiEvseParking {
  parking_id: string;
  /** Upper-cased. */
  evse_position?: string;
}

/** 2.3.0 `Parking`: a place a vehicle parks in while it charges. */
export interface OcpiParking {
  id: string;
  physical_reference?: string;
  /** Upper-cased. */
  vehicle_types?: string[];
  /** Kilograms. */
  max_vehicle_weight?: number;
  /** Centimetres, as are the other lengths. */
  max_vehicle_height?: number;
  max_vehicle_length?: number;
  max_vehicle_width?: number;
  parking_space_length?: number;
  parking_space_width?: number;
  dangerous_goods_allowed?: boolean;
  /** Upper-cased. */
  direction?: string;
  drive_through?: boolean;
  restricted_to_type?: boolean;
  reservation_required?: boolean;
  /** Minutes. */
  time_limit?: number;
  roofed?: boolean;
  images?: OcpiImage[];
  lighting?: boolean;
  refrigeration_outlet?: boolean;
  standards?: string[];
  apds_reference?: string;
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
  /** 2.3.0 `ConnectorCapability`: the ISO 15118 Plug & Charge versions the connector supports. */
  capabilities?: string[];
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
  status_schedule?: OcpiStatusSchedule[];
  connectors: OcpiConnector[];
  floor_level?: string;
  coordinates?: OcpiGeoPoint;
  physical_reference?: string;
  directions?: OcpiDisplayText[];
  parking_restrictions?: string[];
  /** 2.3.0. */
  parking?: OcpiEvseParking[];
  /** 2.3.0. */
  accepted_service_providers?: string[];
  images?: OcpiImage[];
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
  coordinates: OcpiGeoPoint;
  related_locations?: OcpiAdditionalGeoLocation[];
  parking_type?: string;
  evses: OcpiEvse[];
  /** 2.3.0. */
  parking_places?: OcpiParking[];
  directions?: OcpiDisplayText[];
  operator?: OcpiBusinessDetails;
  suboperator?: OcpiBusinessDetails;
  owner?: OcpiBusinessDetails;
  facilities?: string[];
  time_zone?: string;
  opening_times?: OcpiOpeningTimes;
  charging_when_closed?: boolean;
  images?: OcpiImage[];
  energy_mix?: OcpiEnergyMix;
  /** 2.3.0: a number a driver may call for assistance. */
  help_phone?: string;
  last_updated?: string;
  /** OCPDB: the upstream source the aggregator took the location from. */
  source?: string;
  /** OCPDB: the id that source gave the location. */
  original_id?: string;
}

export interface OcpiEnergySource {
  source: string;
  percentage: number;
}

export interface OcpiEnvironmentalImpact {
  category: string;
  /** g/kWh. */
  amount: number;
}

export interface OcpiEnergyMix {
  is_green_energy?: boolean;
  energy_sources?: OcpiEnergySource[];
  environ_impact?: OcpiEnvironmentalImpact[];
  supplier_name?: string;
  energy_product_name?: string;
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
  /** 2.3.0 `BookingRestrictionType`: the element prices a booking, not a charging session. */
  booking?: string;
  /**
   * Restrictions the publisher set that the decoder could not read, or that
   * OCPI does not define (`restrictions` when the whole value is no object).
   * The element cannot be applied as published.
   */
  unreadable?: string[];
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
  /** 2.3.0: what a payment terminal preauthorises for a session. */
  preauthorize_amount?: number;
  elements: OcpiTariffElement[];
  start_date_time?: string;
  end_date_time?: string;
  energy_mix?: OcpiEnergyMix;
  /** 2.3.0: `YES`, `NO` or `N/A`; another value is kept as written, upper-cased, for the mapping to judge. */
  tax_included?: string;
  last_updated?: string;
  /** OCPDB: the upstream source the aggregator took the tariff from. */
  source?: string;
  original_id?: string;
}
