import type { CapPair } from "@openconditions/model-hazards";

export type { CapPair };

/**
 * A CAP `area`: its name, its shapes and codes as CAP writes them, and its
 * vertical extent in feet, a string in XML and a number in MeteoAlarm's JSON.
 */
export interface CapArea {
  areaDesc: string;
  polygon?: string[];
  circle?: string[];
  geocode?: CapPair[];
  altitude?: string | number;
  ceiling?: string | number;
  /** Not CAP: the NWS zones the area covers, `<type>/<id>` (`forecast/FLZ019`), from NWS's `affectedZones`. */
  zones?: string[];
}

/** A CAP `resource`: a file the message points to or embeds. */
export interface CapResource {
  resourceDesc: string;
  mimeType: string;
  size?: string | number;
  uri?: string;
  derefUri?: string;
  digest?: string;
}

/** A CAP `info` block: one language of what the message warns of. */
export interface CapInfo {
  language?: string;
  category: string[];
  event: string;
  responseType?: string[];
  urgency: string;
  severity: string;
  certainty: string;
  audience?: string;
  eventCode?: CapPair[];
  effective?: string;
  onset?: string;
  expires?: string;
  /** Not CAP: NWS's `ends`, when the hazard itself is expected to end. */
  ends?: string;
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  contact?: string;
  parameter?: CapPair[];
  resource?: CapResource[];
  area?: CapArea[];
}

/**
 * A CAP message in CAP's own shape: every repeatable element a list, every
 * value a string. MeteoAlarm serves this shape as JSON; the XML decoder
 * produces it from CAP XML.
 */
export interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  source?: string;
  scope: string;
  restriction?: string;
  addresses?: string;
  code?: string[];
  note?: string;
  references?: string;
  incidents?: string;
  info?: CapInfo[];
}
