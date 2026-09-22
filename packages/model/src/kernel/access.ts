/**
 * What a source's access mode allows. A **bulk** source is polled on
 * OpenConditions' own cadence and yields the full current state, its history
 * and — within the licence — federation and export. An **on-demand** source
 * is fetched only for the area a consumer asks about, under the publisher's
 * request limits: its rows are a TTL-cached partial picture, so they are
 * never written to the observation partitions or the revision tables, and
 * never federated or exported. Many instances federating each other's
 * on-demand answers would rebuild exactly the bulk collection those terms
 * forbid.
 */

import { FUSED_SOURCE_ID } from "./provenance.js";

interface AccessRecord {
  provenance: { accessMode: string; sourceId: string };
}

export function isOnDemand(record: AccessRecord): boolean {
  return record.provenance.accessMode === "on_demand";
}

/** Whether a record may go to the federation outbox, an export or an archive. */
export function federationEligible(record: AccessRecord): boolean {
  return !isOnDemand(record) && record.provenance.sourceId !== FUSED_SOURCE_ID;
}

/** Whether a record's history is kept (revisions, observation partitions, rollups). */
export function historyEligible(record: AccessRecord): boolean {
  return !isOnDemand(record);
}
