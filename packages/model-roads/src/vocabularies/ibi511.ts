/**
 * IBI 511 event types as documented by the 511 deployments (511on.ca, 511ny.org,
 * 511.alberta.ca, 511.idaho.gov list the first three; 511ga.org adds
 * specialEvents). Sub types are free text: the docs say there is no fixed list.
 */
export const IBI511 = {
  eventTypes: ["roadwork", "closures", "accidentsAndIncidents", "specialEvents"],
} as const;
