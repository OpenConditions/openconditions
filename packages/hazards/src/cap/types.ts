import type { CapPair } from "@openconditions/model-hazards";

export type { CapPair };

/** A CAP `area`: its name, and its shapes and codes as CAP writes them. */
export interface CapArea {
  areaDesc: string;
  polygon?: string[];
  circle?: string[];
  geocode?: CapPair[];
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
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  contact?: string;
  parameter?: CapPair[];
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
  scope: string;
  code?: string[];
  references?: string;
  info?: CapInfo[];
}
