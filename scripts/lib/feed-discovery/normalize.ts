import { isPublicLicense, licenseInfo } from "@openconditions/ingest-framework";
import { type Candidate, type CatalogId, DiscoveryError, type Distribution } from "./model.js";

const HARMLESS_QUERY = new Set([
  "service",
  "request",
  "version",
  "typename",
  "typenames",
  "outputformat",
  "srsname",
  "count",
  "crs",
]);
/** Presentation only. Original URLs stay local to matching; never serialize them. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:", "mqtt:", "mqtts:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    const query = new URLSearchParams();
    for (const [key, val] of url.searchParams)
      query.append(key, HARMLESS_QUERY.has(key.toLowerCase()) ? val : "[REDACTED]");
    url.search = query.toString();
    return url.href;
  } catch {
    return "";
  }
}
/** Bounded display hints exclude contact details and inline credential assignments. */
export function hint(value: unknown): string {
  if (typeof value !== "string") return "";
  return (
    value
      .slice(0, 4096)
      .replace(/(?:https?|mqtts?):\/\/[^\s<>"']+/gi, (url) => redactUrl(url))
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[CONTACT]")
      .replace(/\b(?:phone|tel|telephone)\s*[:.]?\s*\+?\d[\d ().-]{7,}\d/gi, "[CONTACT]")
      .replace(
        /\b(?:token|secret|password|api[-_ ]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "[REDACTED]",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip unsafe metadata control characters.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .trim()
  );
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((v) => (typeof v === "string" ? strings(v) : []));
  return [];
}
export function fields(obj: Record<string, unknown>, names: string[]): string[] {
  return [...new Set(names.flatMap((name) => strings(obj[name])))].sort();
}
function localized(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = record(value);
  return obj
    ? (strings(
        obj["en"] ?? obj["default"] ?? Object.values(obj).find((v) => typeof v === "string"),
      )[0] ?? "")
    : "";
}
export function themes(value: unknown): string[] {
  if (typeof value === "string" && value.length < 16384 && value.trim().startsWith("{")) {
    try {
      return Object.keys(record(JSON.parse(value)) ?? {}).sort();
    } catch {
      return strings(value);
    }
  }
  return strings(value);
}
const ALPHA3: Record<string, string> = {
  DEU: "DE",
  BEL: "BE",
  LVA: "LV",
  NLD: "NL",
  FRA: "FR",
  LUX: "LU",
  EST: "EE",
  LTU: "LT",
};
export function countries(raw: string[], fallback: string): string[] {
  const observed = raw.flatMap((v) => {
    const token = v.split(/[/#]/).at(-1)?.toUpperCase() ?? "";
    const country = ALPHA3[token];
    if (country) return [country];
    if (/^(DE|BE|LV|NL|FR|LU|EE|LT)(?:\d|$)/.test(token)) return [token.slice(0, 2)];
    return [];
  });
  return [...new Set([fallback, ...observed])].sort();
}
const ALIASES: Record<string, string> = {
  "cc-by-40": "CC-BY-4.0",
  "cc0-10": "CC0-1.0",
  "dl-de-by-20-1": "DL-DE-BY-2.0",
  "dl-de-zero-20-1": "DL-DE-ZERO-2.0",
  "cc-by-sa-40": "CC-BY-SA-4.0",
  "cc-by-30-de": "CC-BY-3.0-DE",
};
for (const scheme of ["http", "https"]) {
  for (const [token, id] of Object.entries({
    CC0: "CC0-1.0",
    CC_BY_4_0: "CC-BY-4.0",
    CC_BYSA_4_0: "CC-BY-SA-4.0",
    ODC_BL: "ODbL-1.0",
  })) {
    ALIASES[`${scheme}://publications.europa.eu/resource/authority/licence/${token}`] = id;
  }
}
export function licenseOf(licenses: Distribution["licenses"]): Candidate["license"] {
  const declared = [
    ...new Set(
      licenses.declarations.filter((v) => !/^(?:not\s?specified|other)$/i.test(v) && v.trim()),
    ),
  ];
  if (!declared.length) return { state: "absent", public: false };
  const ids = declared.map((v) => ALIASES[v] ?? (licenseInfo(v) ? v : undefined));
  if (new Set(ids.map((id, i) => id ?? declared[i])).size > 1)
    return { state: "conflicting", public: false };
  const id = ids[0];
  return id
    ? { state: "mapped", id, public: isPublicLicense(id) }
    : { state: "unmapped", public: false };
}
export function baseDistribution(catalog: CatalogId, datasetId: string): Distribution {
  return {
    catalog,
    datasetId,
    metadataUrl: "",
    title: "",
    description: "",
    countries: [],
    spatial: [],
    themes: [],
    accessUrls: [],
    downloadUrls: [],
    sampleUrls: [],
    formats: [],
    standards: [],
    protocols: [],
    communication: [],
    licenses: { origin: "distribution", declarations: [] },
    evidenceOrigins: { rights: "absent", accessConditions: "absent", usageConditions: "absent" },
    rights: [],
    accessConditions: [],
    usageConditions: [],
    publisher: "",
    frequency: [],
    modified: "",
  };
}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function parseCkan(
  value: unknown,
  catalog: CatalogId,
): { count: number; datasets: string[]; distributions: Distribution[] } {
  const body = record(value),
    result = record(body?.["result"]);
  if (
    body?.["success"] !== true ||
    !result ||
    !Number.isSafeInteger(result["count"]) ||
    (result["count"] as number) < 0 ||
    !Array.isArray(result["results"])
  )
    throw new DiscoveryError("invalid_envelope");
  const datasets: string[] = [],
    distributions: Distribution[] = [];
  for (const entry of result["results"]) {
    const data = record(entry);
    if (
      !data ||
      typeof data["id"] !== "string" ||
      !UUID.test(data["id"]) ||
      !Array.isArray(data["resources"])
    )
      throw new DiscoveryError("invalid_envelope");
    const id = data["id"].toLowerCase();
    datasets.push(id);
    const seed =
      catalog === "mobidrom"
        ? "https://www.mobilitaetsdaten.nrw/api/ckan"
        : "https://transportdata.be";
    for (const raw of data["resources"]) {
      const res = record(raw);
      if (!res || typeof res["id"] !== "string" || !UUID.test(res["id"]))
        throw new DiscoveryError("invalid_envelope");
      const d = baseDistribution(catalog, id);
      d.distributionId = res["id"].toLowerCase();
      d.datasetName = typeof data["name"] === "string" ? data["name"] : "";
      d.metadataUrl = `${seed}${catalog === "mobidrom" ? "/de" : ""}/dataset/${id}`;
      d.title = localized(data["title_translated"]) || localized(data["title"]);
      d.description = localized(data["notes_translated"]) || localized(data["notes"]);
      d.accessUrls = fields(res, ["url", "access_url", "accessURL"]);
      d.downloadUrls = fields(res, ["download_url", "downloadURL"]);
      d.sampleUrls = fields(res, ["sample", "sample_url"]);
      d.formats = fields(res, ["format", "mimetype"]);
      d.standards = fields(res, ["mobility_data_standard", "mobilityDataStandard", "acc_mod"]);
      d.protocols = fields(res, [
        "application_layer_protocol",
        "applicationLayerProtocol",
        "acc_int",
      ]);
      d.communication = fields(res, ["communication_method", "communicationMethod", "acc_con"]);
      const resourceLicenses = fields(res, [
        "license_id",
        "license_type",
        "license_url",
        "license",
      ]);
      d.licenses = resourceLicenses.length
        ? { origin: "distribution", declarations: resourceLicenses }
        : { origin: "dataset", declarations: fields(data, ["license_id", "license_url"]) };
      for (const [field, names] of Object.entries({
        rights: ["rights"],
        accessConditions: ["conditions_access", "access_conditions"],
        usageConditions: ["conditions_usage", "usage_conditions"],
      })) {
        const own = fields(res, names),
          fallback = fields(data, names),
          key = field as "rights" | "accessConditions" | "usageConditions";
        d[key] = own.length ? own : fallback;
        d.evidenceOrigins[key] = own.length
          ? "distribution"
          : fallback.length
            ? "dataset"
            : "absent";
      }
      d.themes = [...new Set([...themes(data["mobility_theme"]), ...themes(data["theme"])])].sort();
      d.spatial = fields(data, ["nuts_codes", "countries_covered", "spatial"]);
      d.countries = countries(d.spatial, catalog === "mobidrom" ? "DE" : "BE");
      d.publisher =
        localized(record(data["organization"])?.["title"]) || localized(data["publisher"]);
      d.frequency = fields(data, ["frequency", "update_frequency"]);
      d.modified = typeof data["metadata_modified"] === "string" ? data["metadata_modified"] : "";
      distributions.push(d);
    }
  }
  return { count: result["count"] as number, datasets, distributions };
}
