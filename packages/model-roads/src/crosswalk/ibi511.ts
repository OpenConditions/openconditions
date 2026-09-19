/**
 * IBI 511 `EventType` → roads classification. `EventSubType` is free text per
 * deployment (the docs publish no list), so the parser refines a subtype
 * only through its own known tokens, never through this crosswalk.
 */
export const IBI511_SITUATIONS: Readonly<Record<string, string | null>> = {
  roadwork: "roadworks.works",
  closures: "closure.closure",
  accidentsAndIncidents: "incident.accident",
  specialEvents: "public_event.event",
};
