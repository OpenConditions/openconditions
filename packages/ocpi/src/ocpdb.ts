import { decodeOcpiList, isRecord, text } from "./decode.js";

export interface OcpdbSource {
  name: string;
  license?: string;
  contributor?: string;
}

/**
 * EVSE uid to the tariff ids that apply to it, from the OCPI 3.0
 * tariff-associations endpoint. An association's own `id` is the id the 2.2
 * tariffs endpoint publishes the tariff under; its `tariff_id` is the 3.0 id,
 * which the 2.2 endpoint does not resolve, so it is read only when `id` is absent.
 */
export function ocpdbAssociations(payload: Buffer): Map<string, string[]> {
  const byEvse = new Map<string, string[]>();
  for (const association of decodeOcpiList<unknown>(payload)) {
    if (!isRecord(association)) continue;
    const tariffId = text(association.id) ?? text(association.tariff_id);
    if (tariffId === undefined || !Array.isArray(association.evses)) continue;
    for (const evse of association.evses) {
      const uid = isRecord(evse) ? text(evse.evse_uid) : undefined;
      if (uid === undefined) continue;
      const ids = byEvse.get(uid);
      if (ids === undefined) byEvse.set(uid, [tariffId]);
      else if (!ids.includes(tariffId)) ids.push(tariffId);
    }
  }
  return byEvse;
}

/** The upstream sources an OCPDB location can name, by `uid`, with their licence and contributor. */
export function ocpdbSources(payload: Buffer): Map<string, OcpdbSource> {
  const sources = new Map<string, OcpdbSource>();
  for (const entry of decodeOcpiList<unknown>(payload)) {
    if (!isRecord(entry)) continue;
    const uid = text(entry.uid);
    const name = text(entry.name);
    if (uid === undefined || name === undefined) continue;
    const source: OcpdbSource = { name };
    const license = text(entry.attribution_license);
    const contributor = text(entry.attribution_contributor);
    if (license !== undefined) source.license = license;
    if (contributor !== undefined) source.contributor = contributor;
    sources.set(uid, source);
  }
  return sources;
}
