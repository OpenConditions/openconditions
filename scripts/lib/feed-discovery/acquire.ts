import { guardedFetch } from "@openconditions/ingest-framework";
import { type CatalogId, type CatalogResult, DiscoveryError, type Distribution } from "./model.js";
import { parseCkan } from "./normalize.js";
import { parseRdf } from "./rdf.js";

export const CATALOGS = {
  mobidrom: "https://www.mobilitaetsdaten.nrw/api/ckan/api/3/action/package_search",
  belgium: "https://transportdata.be/api/3/action/package_search",
  latvia: "https://transportdata.gov.lv/api/v1/subscriber/metadata_dcat",
} as const;
export const LIMITS = {
  pages: 20,
  rows: 100,
  datasets: 2000,
  responseBytes: 10 * 1024 * 1024,
  totalBytes: 30 * 1024 * 1024,
  requestMs: 30000,
  catalogMs: 90000,
} as const;
/** Exact requests built by this tool; safe to expose their constant paging parameters. */
export function metadataRequestUrl(catalog: CatalogId, start = 0): string {
  if (catalog === "latvia") return CATALOGS.latvia;
  const url = new URL(CATALOGS[catalog]);
  url.search = new URLSearchParams({
    q: "*:*",
    sort: "id asc",
    rows: String(LIMITS.rows),
    start: String(start),
  }).toString();
  return url.href;
}
export function isMetadataRequestUrl(value: string): boolean {
  if (value === CATALOGS.latvia) return true;
  try {
    const url = new URL(value),
      start = Number(url.searchParams.get("start"));
    return (
      Number.isSafeInteger(start) &&
      start >= 0 &&
      start < LIMITS.datasets &&
      (["mobidrom", "belgium"] as const).some(
        (catalog) => value === metadataRequestUrl(catalog, start),
      )
    );
  } catch {
    return false;
  }
}
/** No environment-owned private-host exceptions or redirects. */
export function metadataFetch(): typeof fetch {
  return guardedFetch(undefined, {
    maxBytes: LIMITS.responseBytes,
    timeoutMs: LIMITS.requestMs,
    maxRedirects: 0,
  });
}
function failure(error: unknown, signal: AbortSignal): DiscoveryError {
  if (error instanceof DiscoveryError) return error;
  if (
    signal.aborted ||
    (error instanceof Error && /timed out|timeout|abort/i.test(error.name + error.message))
  )
    return new DiscoveryError("timeout");
  // Guard errors are classified locally; their text, URLs and upstream bytes never enter a report.
  if (error instanceof Error && /redirect refused/.test(error.message))
    return new DiscoveryError("redirect_refused");
  if (error instanceof Error && /exceeds max|body exceeded/.test(error.message))
    return new DiscoveryError("body_cap");
  return new DiscoveryError("request_failed");
}
async function body(
  url: string,
  fetchFn: typeof fetch,
  catalogSignal: AbortSignal,
  remainingBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (remainingBytes <= 0) throw new DiscoveryError("total_cap");
  const maxBytes = Math.min(LIMITS.responseBytes, remainingBytes);
  const capCode = remainingBytes < LIMITS.responseBytes ? "total_cap" : "body_cap";
  const signal = AbortSignal.any([catalogSignal, AbortSignal.timeout(LIMITS.requestMs)]);
  // Also race injected fetch/readers: an implementation ignoring AbortSignal cannot hold the CLI open.
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new DiscoveryError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      aborted,
      (async () => {
        signal.throwIfAborted();
        const response = await fetchFn(url, {
          redirect: "error",
          signal,
          headers: { Accept: "application/json, application/rdf+xml;q=0.9" },
        });
        if (response.status >= 300 && response.status < 400)
          throw new DiscoveryError("redirect_refused");
        if (!response.ok) throw new DiscoveryError("http_status");
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel();
          throw new DiscoveryError(capCode);
        }
        const reader = response.body?.getReader();
        if (!reader) return { text: "", bytes: 0 };
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) throw new DiscoveryError(capCode);
            chunks.push(chunk.value);
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        return { text: Buffer.concat(chunks).toString("utf8"), bytes };
      })(),
    ]);
  } catch (error) {
    throw failure(error, signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function acquire(
  catalog: CatalogId,
  fetchFn: typeof fetch = metadataFetch(),
): Promise<{ result: CatalogResult; distributions: Distribution[] }> {
  const signal = AbortSignal.timeout(LIMITS.catalogMs);
  const result: CatalogResult = {
    catalog,
    limits: LIMITS,
    metadataUrls: [],
    complete: false,
    datasets: 0,
    distributions: 0,
    diagnostics: [],
    scope:
      catalog === "latvia"
        ? "Dataset nodes in the tested mobilityDCAT RDF/XML subset"
        : "Public active datasets returned by package_search",
  };
  const distributions: Distribution[] = [];
  let total = 0;
  const request = async (url: string) => {
    result.metadataUrls.push(url);
    const response = await body(url, fetchFn, signal, LIMITS.totalBytes - total);
    total += response.bytes;
    if (total > LIMITS.totalBytes) throw new DiscoveryError("total_cap");
    return response.text;
  };
  try {
    if (catalog === "latvia") {
      const parsed = parseRdf(await request(CATALOGS[catalog]));
      result.datasets = parsed.datasets.length;
      distributions.push(...parsed.distributions);
      if (parsed.datasets.length > LIMITS.datasets) throw new DiscoveryError("page_limit");
      if (parsed.missingDataset) throw new DiscoveryError("missing_dataset");
      result.complete = true;
    } else {
      let expected: number | undefined,
        start = 0;
      const seen = new Set<string>();
      for (let page = 0; page < LIMITS.pages; page++) {
        const url = metadataRequestUrl(catalog, start);
        let json: unknown;
        const text = await request(url);
        try {
          json = JSON.parse(text);
        } catch {
          throw new DiscoveryError("invalid_json");
        }
        const parsed = parseCkan(json, catalog);
        if (expected !== undefined && expected !== parsed.count)
          throw new DiscoveryError("count_drift");
        expected = parsed.count;
        if (parsed.count > LIMITS.datasets) throw new DiscoveryError("page_limit");
        if (parsed.datasets.length > LIMITS.rows || start + parsed.datasets.length > parsed.count)
          throw new DiscoveryError("invalid_envelope");
        if (
          parsed.datasets.some((id) => seen.has(id)) ||
          new Set(parsed.datasets).size !== parsed.datasets.length
        )
          throw new DiscoveryError("repeated_id");
        if (!parsed.datasets.length && start < expected)
          throw new DiscoveryError("premature_empty");
        for (const id of parsed.datasets) seen.add(id);
        distributions.push(...parsed.distributions);
        start += parsed.datasets.length;
        result.datasets = start;
        if (start === expected) {
          result.complete = true;
          break;
        }
      }
      if (!result.complete) throw new DiscoveryError("page_limit");
    }
  } catch (error) {
    result.diagnostics.push(failure(error, signal).code);
  }
  result.distributions = distributions.length;
  return { result, distributions };
}
