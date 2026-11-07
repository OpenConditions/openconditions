import {
  checkPunShard,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  punManifest,
} from "@openconditions/ingest-framework";
import { z } from "zod";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { type Lifecycle, siteDraft } from "../site.js";

const rowSchema = z.object({
  id_evse: z.string().trim().min(1),
  lat: z.number().min(35).max(47.5),
  lon: z.number().min(6).max(19),
  indirizzo: z.string().nullable(),
  cap: z
    .string()
    .regex(/^[0-9]{5}$/)
    .nullable(),
  cpo: z.string().nullable(),
  party_id: z.string().nullable(),
  stato_raw: z.string(),
  publication_status: z.string(),
  tipo_parcheggio: z.string().nullable(),
  open_24h7: z.boolean(),
  potenza_w: z.number().nonnegative().nullable(),
  corrente: z.string().nullable(),
  standard_connettore: z.string().nullable(),
  n_connettori: z.number().int().nonnegative(),
  real_time: z.boolean(),
});
const shardSchema = z.object({
  _etl_version: z.literal("0.2.0"),
  _source: z.string(),
  _source_url: z.literal("https://www.piattaformaunicanazionale.it/idr"),
  _license: z.literal("CC BY 4.0 ex art. 52 c.2 D.Lgs 82/2005 (CAD)"),
  _generated_at: z.iso.datetime({ offset: true }),
  _snapshot_date: z.iso.date(),
  punti: z.array(rowSchema),
});

/** Inventory only. A complete mirror pass establishes no national census or live states. */
export function parsePun(feed: ChargingCatalogFeed, payloads: FeedPayloads, ctx: ParseContext) {
  const bodies = payloads["main"] ?? [];
  if (bodies.length < 3) throw Error("PUN requires a complete acquired generation");
  const manifest = punManifest(bodies[0]!);
  if (
    bodies.length !== manifest.files.length + 2 ||
    JSON.stringify(manifest) !== JSON.stringify(punManifest(bodies.at(-1)!))
  )
    throw Error("PUN incomplete/mixed generation");
  const rows = new Map<
    string,
    { row: z.infer<typeof rowSchema>; generation: string; snapshot: string }
  >();
  let generation: string | undefined;
  let snapshot: string | undefined;
  for (const [index, file] of manifest.files.entries()) {
    const body = bodies[index + 1]!;
    checkPunShard(body, file);
    const shard = shardSchema.parse(JSON.parse(body.toString()));
    if (
      shard._generated_at.slice(0, 10) !== shard._snapshot_date ||
      Date.parse(shard._generated_at) > Date.parse(manifest.last_run)
    )
      throw Error("PUN invalid source generation");
    if (
      generation !== undefined &&
      (generation !== shard._generated_at || snapshot !== shard._snapshot_date)
    )
      throw Error("PUN mixed shard generations");
    generation = shard._generated_at;
    snapshot = shard._snapshot_date;
    for (const row of shard.punti) {
      const prior = rows.get(row.id_evse);
      if (prior && JSON.stringify(prior.row) !== JSON.stringify(row))
        throw Error(`PUN conflicting EVSE ${row.id_evse}`);
      rows.set(row.id_evse, { row, generation, snapshot });
    }
  }
  if (rows.size === 0) throw Error("PUN empty inventory is not absence authority");
  const out = emptyParseOutput();
  for (const [id, { row, generation, snapshot }] of [...rows].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const lifecycle: Lifecycle =
      row.stato_raw === "REMOVED"
        ? "decommissioned"
        : row.stato_raw === "PLANNED"
          ? "planned"
          : "unknown";
    const feature = siteDraft(
      feed,
      {
        stationId: id,
        point: [row.lon, row.lat],
        lifecycle,
        address: {
          street: row.indirizzo ?? undefined,
          postalCode: row.cap ?? undefined,
          country: "IT",
        },
        operator: row.cpo ? { name: row.cpo } : undefined,
        twentyFourSeven: row.open_24h7 === true ? true : undefined,
        upstream: [
          {
            publisher: "GSE/MASE — PUN, via Cruscotto Italia (AgID)",
            license: "CC-BY-4.0",
          },
        ],
        evses: [
          {
            key: id,
            evseId: id,
            lifecycle,
            connectors:
              row.standard_connettore === null
                ? []
                : [
                    {
                      id: "representative",
                      standard: row.standard_connettore,
                      maxPowerKw: row.potenza_w === null ? undefined : row.potenza_w / 1000,
                      current:
                        row.corrente === "AC" ? "ac" : row.corrente === "DC" ? "dc" : undefined,
                    },
                  ],
          },
        ],
      },
      ctx.fetchedAt,
    );
    feature["extras"] = {
      pun: {
        snapshotDate: snapshot,
        generatedAt: generation,
        status: row.stato_raw,
        publicationStatus: row.publication_status,
        partyId: row.party_id,
        parkingType: row.tipo_parcheggio,
        connectorCount: row.n_connettori,
        representativeStandard: row.standard_connettore,
        sourceLicense: "CC BY 4.0 ex art. 52 c.2 D.Lgs 82/2005 (CAD)",
        representativeConnectorOnly: true,
        coordinateReference: "geographic interpretation; CRS undeclared",
      },
    };
    out.features.push(feature);
  }
  return out;
}
