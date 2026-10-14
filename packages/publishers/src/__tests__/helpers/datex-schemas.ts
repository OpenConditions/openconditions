import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/**
 * The official DATEX II v3 XML schemas the SituationPublication export is
 * validated against, fetched at test time rather than vendored: datex2.eu and
 * docs.datex2.eu publish them without any licence or redistribution terms
 * (only "Copyright © DATEX II"), so this repository does not copy them.
 *
 * Model: DATEX II v3.7, the full per-namespace schemas from
 * https://docs.datex2.eu/downloads/modelv37/ (served under `MODEL_BASE`).
 * Envelope: Exchange 2020.1 `cisxsd.zip` from
 * https://docs.datex2.eu/exchange-2020/downloads/ (`messageContainer` and the
 * namespaces it imports). Retrieved 2026-10-15. Every schema file is pinned by
 * its SHA-256 below (the zip by its members, so a repack does not matter); a
 * changed upstream file fails the check instead of silently moving the schema
 * the export is held to.
 */
const MODEL_BASE = "https://docs.datex2.eu/_static/data/v3.7/";
const EXCHANGE_ZIP = "https://docs.datex2.eu/_static/data/exchange/2020.1/cisxsd.zip";

const MODEL: Readonly<Record<string, string>> = {
  "DATEXII_3_AfirEnergyInfrastructure.xsd":
    "c5439e004e652d26ff3a16965e8f9bf5d4dacf38f13f2f9b965aa78236385ba4",
  "DATEXII_3_AfirFacilities.xsd":
    "63a7f8059b440714d8216f77431bed7f3d8c362bdfba70621c1c564e47b9e3ee",
  "DATEXII_3_Common.xsd": "56a0b3eb3e12e731079339c1c39dbde250eb01de9604af0a49ae1004f7d76099",
  "DATEXII_3_CommonExtension.xsd":
    "7e7d5ff0b16d346935e880bacfc5b68df5e262b0a63ba2722e1b1fb122e8859d",
  "DATEXII_3_ControlledZone.xsd":
    "8d7eb06a61c1f822ff9c9e7195ad4e28f339b3f1f419799a22bde4f8412f1045",
  "DATEXII_3_D2Payload.xsd": "ee68479cb7c3bc9bbf3eff6b76d9abf8766eb0160c70e6fb96688895342f6cb4",
  "DATEXII_3_EnergyInfrastructure.xsd":
    "7fb51e068964564afc71807474f1c7307dda2c85881e1b683682116c19cb35a1",
  "DATEXII_3_Facilities.xsd": "6f2f5500c820e1089f797ccb7ca2c5a9fae678f3239c4310a20efa91649559c3",
  "DATEXII_3_FaultAndStatus.xsd":
    "b2a8b642f4e80b157763172884e1de59fbb64a53c2d1de9e59f017677496e10d",
  "DATEXII_3_LocationExtension.xsd":
    "741b0efc946b559ef97110a7dbbf6ac20590a375a271f39174228af23c437c21",
  "DATEXII_3_LocationReferencing.xsd":
    "4d647ce166abed4d0046f6a723e1503176476dc9db7e824b4cbb07035d80e784",
  "DATEXII_3_Parking.xsd": "468139279a5304de2e03e24b412738ce074fbc35c94261898dad00b48091ac74",
  "DATEXII_3_ReroutingManagementEnhanced.xsd":
    "cdc90c71ce6dda9cb125c404f12a31e98ce92678a3eea662deb2d51485b9b056",
  "DATEXII_3_RoadTrafficData.xsd":
    "54240256240107e4f0cd67718139a7c555ff753e297f6a8502756d14a57d9191",
  "DATEXII_3_Situation.xsd": "bd4d95d9ac0dcf86e31478af3e239a4c4a3502f70435c6e7f058c79c6c861ed4",
  "DATEXII_3_TrafficManagementPlan.xsd":
    "13921c1ba03958e3a33fabebb76f0fdf0840624382782f16d17d7707547bee96",
  "DATEXII_3_TrafficRegulation.xsd":
    "47a7bbab15ecacb18a47cea60d16a793832c74d3bb5c5e507675dbbb257738f9",
  "DATEXII_3_UrbanExtensions.xsd":
    "392b65a86bfbb5a916df95e135aeddc6eb9f9196bae66a5ca5e22339781d2e7c",
  "DATEXII_3_Vms.xsd": "46cf6bbc255b07d22e4973d64b9e45bc69640615cfbba96c96dc6ada14af9f2b",
};

const EXCHANGE: Readonly<Record<string, string>> = {
  "DATEXII_3_CISInformation.xsd":
    "12fc09298b4bc617d7d49cbc727ecf5ec319539c514da817705da8bc9d342923",
  "DATEXII_3_ExchangeInformation.xsd":
    "a1a5a43b05513bcfbe60ab2662cabe8fb5a61f5822ee6b21e802a074fc410983",
  "DATEXII_3_InformationManagement.xsd":
    "86057b30664e04323de502d07f26a77b8c097b366705e9aea088dad777fe4086",
  "DATEXII_3_MessageContainer.xsd":
    "c97062370eb9d169c9e565d0c59ce86e435ef50558db2ea0f1216cdacf7ebc87",
};

/** The root schema of a `messageContainer` document. */
export const ROOT_SCHEMA = "DATEXII_3_MessageContainer.xsd";

const CACHE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../node_modules/.cache/datex2-v3.7",
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "User-Agent": "OpenConditions schema check" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The stored or deflated members of a zip archive, by name. */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    out.set(name, method === 0 ? data : new Uint8Array(inflateRawSync(data)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function cached(name: string, sha: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(CACHE, name)));
    return sha256(bytes) === sha ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function store(name: string, bytes: Uint8Array, sha: string): Promise<void> {
  const actual = sha256(bytes);
  if (actual !== sha) {
    throw new Error(`${name}: SHA-256 ${actual}, pinned ${sha}; the upstream schema changed`);
  }
  const tmp = join(CACHE, `${name}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, join(CACHE, name));
}

/**
 * The pinned schema set as `{ fileName, contents }`, from the cache or
 * downloaded into it. Throws when a file cannot be fetched or does not match
 * its checksum.
 */
export async function datexSchemas(): Promise<{ fileName: string; contents: string }[]> {
  await mkdir(CACHE, { recursive: true });
  const files = new Map<string, Uint8Array>();
  for (const [name, sha] of Object.entries(MODEL)) {
    let bytes = await cached(name, sha);
    if (!bytes) {
      bytes = await download(`${MODEL_BASE}${name}`);
      await store(name, bytes, sha);
    }
    files.set(name, bytes);
  }
  const exchange = await Promise.all(
    Object.entries(EXCHANGE).map(async ([name, sha]) => [name, await cached(name, sha)] as const),
  );
  if (exchange.some(([, bytes]) => !bytes)) {
    const members = unzip(await download(EXCHANGE_ZIP));
    for (const [name, sha] of Object.entries(EXCHANGE)) {
      const bytes = members.get(name);
      if (!bytes) throw new Error(`${EXCHANGE_ZIP} has no ${name}`);
      await store(name, bytes, sha);
    }
  }
  for (const name of Object.keys(EXCHANGE)) {
    files.set(name, new Uint8Array(await readFile(join(CACHE, name))));
  }
  const decoder = new TextDecoder();
  return [...files].map(([fileName, bytes]) => ({ fileName, contents: decoder.decode(bytes) }));
}
