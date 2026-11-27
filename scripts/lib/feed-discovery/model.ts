/** Metadata observations only; none of these types grant ingestion permission. */
export type CatalogId = "mobidrom" | "belgium" | "latvia";
export type Diagnostic =
  | "http_status"
  | "timeout"
  | "body_cap"
  | "total_cap"
  | "invalid_json"
  | "invalid_envelope"
  | "xml_rejected"
  | "missing_dataset"
  | "count_drift"
  | "page_limit"
  | "repeated_id"
  | "premature_empty"
  | "redirect_refused"
  | "request_failed";
export interface Distribution {
  catalog: CatalogId;
  datasetId: string;
  datasetName?: string;
  datasetIdentifierHint?: string;
  distributionId?: string;
  metadataUrl: string;
  title: string;
  description: string;
  countries: string[];
  spatial: string[];
  themes: string[];
  accessUrls: string[];
  downloadUrls: string[];
  sampleUrls: string[];
  formats: string[];
  standards: string[];
  protocols: string[];
  communication: string[];
  licenses: { origin: "distribution" | "dataset"; declarations: string[] };
  evidenceOrigins: {
    rights: "distribution" | "dataset" | "absent";
    accessConditions: "distribution" | "dataset" | "absent";
    usageConditions: "distribution" | "dataset" | "absent";
  };
  rights: string[];
  accessConditions: string[];
  usageConditions: string[];
  publisher: string;
  frequency: string[];
  modified: string;
}
export interface InventoryFeed {
  id: string;
  domain: string;
  region: string;
  disabled: boolean;
  aggregator: boolean;
  urls: string[];
  termsUrls: string[];
  countries: string[];
  bbox: boolean;
}
export interface CatalogResult {
  catalog: CatalogId;
  metadataUrls: string[];
  complete: boolean;
  datasets: number;
  distributions: number;
  diagnostics: Diagnostic[];
  scope: string;
  limits?: {
    pages: number;
    rows: number;
    datasets: number;
    responseBytes: number;
    totalBytes: number;
    requestMs: number;
    catalogMs: number;
  };
}
export type Priority =
  | "research_gap"
  | "research_extension"
  | "review_constraints"
  | "already_configured";
export interface Candidate extends Omit<Distribution, "datasetName"> {
  id: string;
  status: "needs_review";
  domains: { domain: string; reason: string }[];
  license: {
    state: "absent" | "unmapped" | "conflicting" | "mapped";
    id?: string;
    public: boolean;
  };
  relatedCandidates: string[];
  overlap: { feedId: string; disabled: boolean; reason: string }[];
  priority: Priority;
  reasons: string[];
  caveats: string[];
}
export interface Report {
  schemaVersion: 1;
  generatedAt: string;
  complete: boolean;
  catalogs: CatalogResult[];
  inventory: { feeds: number; scope: string };
  candidates: Candidate[];
  excluded: { no_oc_domain: number };
  collisions: number;
  limitations: string[];
}
export class DiscoveryError extends Error {
  constructor(readonly code: Diagnostic) {
    super(code);
  }
}
