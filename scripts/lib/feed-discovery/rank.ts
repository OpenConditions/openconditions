import { createHash } from "node:crypto";
import type { Candidate, Distribution, InventoryFeed, Priority, Report } from "./model.js";
import { hint, licenseOf, redactUrl } from "./normalize.js";

const ORDER: Priority[] = [
  "research_gap",
  "research_extension",
  "review_constraints",
  "already_configured",
];
/** URL equality deliberately preserves every query byte/order and path case. */
function canonical(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}
function samePath(a: string, b: string): boolean {
  try {
    const x = new URL(a),
      y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
function datasetMatch(value: string, d: Distribution): boolean {
  if (!d.datasetName) return false;
  try {
    const url = new URL(value),
      name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (url.hostname !== new URL(d.metadataUrl).hostname) return false;
    return (
      (url.pathname.includes("/dataset/") && name === d.datasetName) ||
      (url.pathname.endsWith("/package_show") && url.searchParams.get("id") === d.datasetName)
    );
  } catch {
    return false;
  }
}
function templateMatch(pattern: string, value: string): boolean {
  if (!/[{$]/.test(pattern)) return false;
  const prefix = pattern.split(/[{$]/)[0] ?? "";
  try {
    return new URL(prefix).origin === new URL(value).origin && value.startsWith(prefix);
  } catch {
    return false;
  }
}
function sameCatalog(value: string, d: Distribution): boolean {
  try {
    return new URL(value).hostname === new URL(d.metadataUrl).hostname;
  } catch {
    return false;
  }
}
function domains(d: Distribution): Candidate["domains"] {
  const text = [...d.themes, d.title, ...d.formats, ...d.standards].join(" ").toLowerCase();
  const patterns: Record<string, RegExp> = {
    roads:
      /roadworks|road.work|road.incident|traffic.incident|road.restriction|road.closure|traffic.management|sevas|situationpublication|road.event|static-traffic-signs-and-regulations|other-traffic-regulations|weight.and.dimensions.restrictions/,
    parking: /parking|parken|parkride|park.and.ride|apds/,
    cameras: /traffic.camera|webcam/,
    weather: /road.weather|weather.observation|meteorolog/,
    hazards: /hazard|flood.warning|wildfire/,
    charging: /charging|ocpi|electric.vehicle.supply/,
    fuel: /fuel.price|fuel.station/,
    border: /border.wait|border.crossing/,
    vehicles: /maintenance.fleet|road.maintenance.vehicle|iowa.avl|digitraffic.vehicles/,
  };
  return Object.entries(patterns).flatMap(([domain, re]) =>
    re.test(text) ? [{ domain, reason: "theme_or_keyword_hint" }] : [],
  );
}
function excluded(d: Distribution, found: Candidate["domains"]): boolean {
  return (
    !found.length &&
    /gbfs|sharing-and-hiring|shared.mobility|timetable|gtfs|transit.stop|public.transport.stop|transportstops|transport-stops|stop.place/i.test(
      [...d.themes, ...d.formats, ...d.standards, d.title].join(" "),
    )
  );
}
/** Every output field is projected through presentation redaction, including RDF subject IRIs. */
function safeString(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? redactUrl(value) : hint(value);
}
function safe(d: Distribution): Distribution {
  const output = { ...d };
  for (const key of Object.keys(output) as (keyof Distribution)[]) {
    const value = output[key];
    if (typeof value === "string") Object.assign(output, { [key]: safeString(value) });
    else if (Array.isArray(value)) Object.assign(output, { [key]: value.map(safeString) });
  }
  output.licenses = {
    origin: d.licenses.origin,
    declarations: d.licenses.declarations.map(safeString),
  };
  // Typed catalog timestamps and IDs do not pass through contact heuristics.
  output.modified = /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(d.modified)
    ? d.modified
    : hint(d.modified);
  delete output.datasetName;
  return output;
}
function identity(d: Distribution): string {
  const semantic = {
    access: d.accessUrls.map(redactUrl).sort(),
    download: d.downloadUrls.map(redactUrl).sort(),
    formats: d.formats.map(safeString).sort(),
    standards: d.standards.map(safeString).sort(),
    protocols: d.protocols.map(safeString).sort(),
    communication: d.communication.map(safeString).sort(),
    licenses: d.licenses.declarations.map(safeString).sort(),
    rights: d.rights.map(safeString).sort(),
  };
  const hash = createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 24);
  return `${d.catalog}:${safeString(d.datasetId)}:${d.distributionId ? safeString(d.distributionId) : hash}`;
}
export function buildReport(
  distributions: Distribution[],
  inventory: InventoryFeed[],
  now: Date,
): Report {
  const candidates: Candidate[] = [],
    endpointsByCandidate = new Map<Candidate, string[]>();
  let exclusions = 0,
    collisions = 0;
  for (const d of distributions) {
    const mapped = domains(d);
    if (excluded(d, mapped)) {
      exclusions++;
      continue;
    }
    const overlap: Candidate["overlap"] = [];
    const endpoints = [...d.accessUrls, ...d.downloadUrls];
    for (const feed of inventory) {
      let reason: string | undefined;
      if (
        endpoints.some((url) =>
          feed.urls.some((f) => !/[{$]/.test(f) && canonical(f) === canonical(url)),
        )
      )
        reason = "exact_endpoint";
      else if (feed.termsUrls.some((url) => datasetMatch(url, d)))
        reason = "already_configured_dataset";
      else if (endpoints.some((url) => feed.urls.some((f) => !/[{$]/.test(f) && samePath(f, url))))
        reason = "possible_query_overlap";
      else if (endpoints.some((url) => feed.urls.some((f) => templateMatch(f, url))))
        reason = "possible_template_overlap";
      else if (
        feed.aggregator &&
        mapped.some((m) => m.domain === feed.domain) &&
        feed.termsUrls.some((url) => sameCatalog(url, d))
      )
        reason = "possible_aggregate_overlap";
      if (reason) overlap.push({ feedId: feed.id, disabled: feed.disabled, reason });
    }
    overlap.sort((a, b) => a.feedId.localeCompare(b.feedId));
    const license = licenseOf(d.licenses),
      caveats: string[] = ["metadata_only_not_ingestion_approval"];
    const access = [
      ...d.communication,
      ...d.protocols,
      ...d.rights,
      ...d.accessConditions,
      ...d.usageConditions,
    ].join(" ");
    if (/(?:^|[\s/])push(?:$|[\s/])/i.test(access)) caveats.push("push_subscription_unqualified");
    if (/mqtt/i.test(access)) caveats.push("mqtt_subscription_unqualified");
    if (/fee|contract|registration|restricted|permission|authentication/i.test(access))
      caveats.push("access_or_usage_requires_review");
    if (!d.downloadUrls.length)
      caveats.push(
        d.accessUrls.length ? "access_url_only_may_be_landing_page" : "no_endpoint_hint",
      );
    if (!mapped.length) caveats.push("unknown_oc_domain");
    if (!d.formats.length && !d.standards.length) caveats.push("unknown_format");
    if (!license.public)
      caveats.push(
        `license_${license.state === "mapped" ? "not_public_under_oc_policy" : license.state}`,
      );
    if (d.sampleUrls.length) caveats.push("samples_are_not_source_endpoints");
    if (overlap.some((m) => m.reason.startsWith("possible")))
      caveats.push("possible_supplier_or_endpoint_overlap");
    const reasons: string[] = [];
    let gap = false;
    for (const mappedDomain of mapped) {
      for (const country of d.countries) {
        const relevant = inventory.filter((f) => !f.disabled && f.domain === mappedDomain.domain);
        if (
          relevant.some(
            (f) =>
              f.region === country.toLowerCase() ||
              f.countries.some((c) => c.split("-")[0] === country),
          )
        ) {
          reasons.push(`${country}:${mappedDomain.domain}:country_specific_feed_configured`);
          continue;
        }
        const possible = relevant.filter(
          (f) => f.region === "global" || f.region === "eu" || f.bbox,
        );
        if (possible.length) {
          reasons.push(
            `${country}:${mappedDomain.domain}:possibly_covered_by_multinational_or_bbox_feeds`,
          );
          caveats.push(
            "coverage_not_exhaustively_known",
            ...possible.map((f) => `possible_multinational_coverage:${f.id}`),
          );
        } else {
          gap = true;
          reasons.push(`${country}:${mappedDomain.domain}:country_domain_not_configured`);
        }
      }
    }
    let priority: Priority = gap ? "research_gap" : "research_extension";
    if (
      caveats.some(
        (c) =>
          !c.startsWith("possible_multinational_coverage:") &&
          ![
            "metadata_only_not_ingestion_approval",
            "samples_are_not_source_endpoints",
            "coverage_not_exhaustively_known",
          ].includes(c),
      )
    )
      priority = "review_constraints";
    if (
      overlap.some(
        (m) => m.reason === "exact_endpoint" || m.reason === "already_configured_dataset",
      )
    )
      priority = "already_configured";
    reasons.push("priority_ranks_research_only");
    const candidate: Candidate = {
      ...safe(d),
      id: identity(d),
      status: "needs_review",
      relatedCandidates: [],
      domains: mapped,
      license,
      overlap,
      priority,
      reasons: [...new Set(reasons)].sort(),
      caveats: [...new Set(caveats)].sort(),
    };
    candidates.push(candidate);
    endpointsByCandidate.set(candidate, endpoints);
  }
  // Sort semantic collisions by their sanitized full evidence, then number rather than merge.
  candidates.sort(
    (a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const n = (counts.get(candidate.id) ?? 0) + 1;
    counts.set(candidate.id, n);
    if (n > 1) {
      candidate.id += `:collision-${n}`;
      collisions++;
    }
  }
  const byEndpoint = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    // Compare original query values, before presentation redaction can make URLs equal.
    for (const url of endpointsByCandidate.get(candidate) ?? []) {
      const key = canonical(url),
        group = byEndpoint.get(key) ?? [];
      for (const other of group)
        if (other.catalog !== candidate.catalog) {
          other.relatedCandidates.push(candidate.id);
          candidate.relatedCandidates.push(other.id);
        }
      group.push(candidate);
      byEndpoint.set(key, group);
    }
  }
  for (const candidate of candidates)
    candidate.relatedCandidates = [...new Set(candidate.relatedCandidates)].sort();
  candidates.sort(
    (a, b) => ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority) || a.id.localeCompare(b.id),
  );
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    complete: true,
    catalogs: [],
    inventory: {
      feeds: inventory.length,
      scope:
        "Raw baked definitions including disabled feeds; no overlays, runtime catalog children or physical-site comparison",
    },
    candidates,
    excluded: { no_oc_domain: exclusions },
    collisions,
    limitations: [
      "Candidates always need human review; public catalog access and recognized licenses do not establish payload access, freshness, parser support or ingestion readiness.",
      "Country-domain configuration is not geographic coverage proof; global, multinational and bbox feeds may overlap. Operator overlays and runtime children are not inspected.",
      "Partial catalog results never establish withdrawal. Only three fixed catalogs and the tested mobilityDCAT RDF/XML subset are supported.",
      "Query values are redacted except harmless OGC/WFS parameters. Credentials embedded in URL paths or unlabelled free text cannot be reliably detected.",
    ],
  };
}
