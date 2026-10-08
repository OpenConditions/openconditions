import { z } from "zod";
import {
  AtQuery,
  FeatureListQuery,
  FeatureQuery,
  LatestObservationQuery,
  OfferListQuery,
  RecordClassParam,
  SeriesQuery,
  SituationListQuery,
  StreamQuery,
} from "./query.js";

/** One public route as the OpenAPI document describes it. */
export interface ApiRoute {
  /** The OpenAPI path, `{name}` for a path parameter. */
  path: string;
  operationId: string;
  summary: string;
  query?: z.ZodObject;
  params?: Record<string, z.ZodType>;
  /** Media types of a 200 response. */
  produces: readonly string[];
  /** Whether the route answers 404 for an unknown record. */
  notFound?: boolean;
  /** A public emitter: reads in the public scope even for the operator. */
  alwaysPublic?: boolean;
  /** When the route answers 503. */
  unavailable?: string;
}

const RecordId = z.string().min(1).describe("the record id, URL-encoded");

/** How a JSON collection reads on-demand sources through, appended to its summary. */
const ON_DEMAND =
  " A read with `bbox` and a kind, property or domain an on-demand source produces, of the records this route lists, first fetches that source's stale grid cells inside its coverage, within its request limits, waiting up to `OPENCONDITIONS_ON_DEMAND_DEADLINE_MS` (default 3000); the response then carries `coverage: { partial, sources: [{ id, complete, reason? }] }`, `reason` one of `too_many_cells`, `limited`, `failed`, `deadline` or `missing_configuration`. `partial` is true when a source that could answer fell short; a source missing its configuration is listed with its reason but does not make the answer partial. A partial answer is not cached. A read without `bbox`, or for a past `at`, never fetches; `source` limits the sources fetched.";

/** The record API: every route here is registered by `registerApiRoutes`. */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    path: "/situations",
    operationId: "listSituations",
    summary: "Live situations as records, one keyset page ordered by id.",
    query: SituationListQuery,
    produces: ["application/json"],
  },
  {
    path: "/situations.geojson",
    operationId: "listSituationsGeoJson",
    summary: "Live situations as a GeoJSON FeatureCollection, one keyset page.",
    query: SituationListQuery,
    produces: ["application/geo+json"],
    alwaysPublic: true,
  },
  {
    path: "/situations.jsonld",
    operationId: "listSituationsJsonLd",
    summary: "Live situations as GeoJSON-LD (schema.org and SOSA context), one keyset page.",
    query: SituationListQuery,
    produces: ["application/ld+json"],
    alwaysPublic: true,
  },
  {
    path: "/traff.xml",
    operationId: "listSituationsTraff",
    summary:
      'Live situations as a TraFF 0.8 feed, one keyset page; `Link: rel="next"` names the next. Situations TraFF cannot tell without widening a vehicle condition are left out.',
    query: SituationListQuery,
    produces: ["application/xml"],
    alwaysPublic: true,
  },
  {
    path: "/datex2/situations.xml",
    operationId: "listSituationsDatex",
    summary:
      'Live situations as a DATEX II v3 SituationPublication, one record per effect, one keyset page; `Link: rel="next"` names the next. Not SRTI-profile-conformant.',
    query: SituationListQuery,
    produces: ["application/xml"],
    alwaysPublic: true,
  },
  {
    path: "/stream",
    operationId: "streamSituations",
    summary:
      "Server-sent events: every live matching situation, then each one that changes (`event: situation`) or goes (`event: remove`), polled every 15 s.",
    query: StreamQuery,
    produces: ["text/event-stream"],
    alwaysPublic: true,
    unavailable:
      "The instance serves as many live streams as it allows; `Retry-After` says when to retry",
  },
  {
    path: "/situations/{id}",
    operationId: "getSituation",
    summary:
      "One situation, tombstoned or not (one past its `freshness.expiresAt` at `at` answers 404), with its evidence, the graph binding of its place (`binding`) and of each effect with a place of its own (`effectBindings`, by effect id).",
    query: AtQuery,
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/features",
    operationId: "listFeatures",
    summary:
      "Live features as records, one keyset page ordered by id (the limit counts features); `canonical=1` serves one feature per cluster of linked features under its canonical id. Components only with `expand=components`; `expand=latest` adds `latest` (each feature's readings in effect, by feature id) and `expand=offers` adds `offers` (each feature's live offers, by feature id). A reading is `{ property, componentKey?, qualifiers?, result, phenomenonTime, validUntil?, source, contributors? }`; a fused reading lists the sources it was fused from in `contributors`. The operator reads `@fused`, the fusion of every source; the public scope reads a fusion of public sources only: `@fused` when every contributor is public, else `@fused-public`, and none when no contributor is public." +
      ON_DEMAND,
    query: FeatureListQuery,
    produces: ["application/json"],
  },
  {
    path: "/features.geojson",
    operationId: "listFeaturesGeoJson",
    summary:
      "Live features as a GeoJSON FeatureCollection, one keyset page. `expand` takes components only: latest and offers are ignored.",
    query: FeatureListQuery,
    produces: ["application/geo+json"],
    alwaysPublic: true,
  },
  {
    path: "/features.jsonld",
    operationId: "listFeaturesJsonLd",
    summary:
      "Live features as GeoJSON-LD (schema.org and SOSA context), one keyset page. `expand` takes components only: latest and offers are ignored.",
    query: FeatureListQuery,
    produces: ["application/ld+json"],
    alwaysPublic: true,
  },
  {
    path: "/features/{id}",
    operationId: "getFeature",
    summary:
      "One feature, tombstoned or not (one past its `freshness.expiresAt` at `at` answers 404), with its components and the canonical cluster it belongs to; a canonical id serves the cluster's canonical feature. An expired on-demand record the read would serve is first fetched again from its own source's grid cell, within that source's request limits and the read-through deadline; a read for a past `at` fetches nothing. `expand=latest` adds `latest`, its readings in effect (shaped as in `/features`; a fused reading names its contributing sources in `contributors`), and `expand=offers` adds `offers`, its live offers.",
    query: FeatureQuery,
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/offers",
    operationId: "listOffers",
    summary: `Live offers (tariffs) as records, one keyset page ordered by id.${ON_DEMAND}`,
    query: OfferListQuery,
    produces: ["application/json"],
  },
  {
    path: "/offers/{id}",
    operationId: "getOffer",
    summary: "One offer, tombstoned or not; one past its `freshness.expiresAt` answers 404.",
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/observations/latest",
    operationId: "listLatestObservations",
    summary:
      "The reading in effect of every matching series, one keyset page ordered by series (the cursor is a series id); `canonical=1` serves fused readings where several sources or the crowd report a property: `@fused`, fused from every source, for the operator; in public scope a fusion of public sources only (`@fused` when every contributor is public, else `@fused-public`). `source=@fused` and `source=@fused-public` follow the request's scope the same way." +
      ON_DEMAND,
    query: LatestObservationQuery,
    produces: ["application/json"],
  },
  {
    path: "/observations",
    operationId: "getSeries",
    summary:
      "One series over a range: raw readings within the property's raw retention, hourly or daily rollups beyond it (or as `resolution` asks), oldest first, one page. A series that keeps no history (a lane's or a vehicle class's) answers 400: its reading in effect is at `/observations/latest`.",
    query: SeriesQuery,
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/history/{class}/{id}",
    operationId: "getHistory",
    summary: "A record's revisions, oldest first: what changed and the record as it stood.",
    params: { class: RecordClassParam, id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/taxonomy",
    operationId: "getTaxonomy",
    summary: "The running registry: domains, kinds, types, properties, effects, vocabularies.",
    produces: ["application/json"],
  },
  {
    path: "/schemas/{path}",
    operationId: "getSchema",
    summary: "A generated JSON Schema of the running registry; `index.json` lists them.",
    params: { path: z.string().min(1).describe("e.g. index.json or situation/incident@1.json") },
    produces: ["application/schema+json"],
    notFound: true,
  },
  {
    path: "/coverage",
    operationId: "getCoverage",
    summary:
      "Live records (not tombstoned, not past their expiry) per country, subdivision, class, kind and access mode, and live series per property, with the sources behind them. The public scope neither counts nor names a restricted source.",
    produces: ["application/json"],
  },
  {
    path: "/sources",
    operationId: "listSources",
    summary:
      "The feeds this instance serves, by id: name, licence (`license`, the SPDX or `LicenseRef-` id, and `licenseName`, its readable name), attribution, homepage, terms (url, review date and note), rights, and coverage (the ISO 3166 `countries` a feed covers, or the `bbox` an on-demand feed answers for; a global one covers the world), for crediting and disclosing them and for knowing which areas a feed stands for. A camera feed whose stills a consumer may proxy lists their hosts in `imageHosts` (an exact host, `*.domain`, or `host/path/`). Catalogue children are credited through their parent; disabled feeds are left out. A restricted feed is listed and marked `restricted` (its records are withheld from the public scope, the entry is metadata). The list is the same in both scopes; `scope` (`public` or `operator`) names the scope the request was served in, so a consumer knows whether the restricted feeds' records reach it.",
    produces: ["application/json"],
  },
  {
    path: "/openapi.json",
    operationId: "getOpenApi",
    summary: "This document.",
    produces: ["application/json"],
  },
];

/** A zod schema's request-side JSON Schema, without the meta keys a parameter does not take. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest as Record<string, unknown>;
}

function parameters(route: ApiRoute): unknown[] {
  const out: unknown[] = [];
  for (const [name, schema] of Object.entries(route.params ?? {})) {
    const json = inputSchema(schema);
    out.push({ name, in: "path", required: true, schema: json, description: json["description"] });
  }
  if (route.query) {
    const json = inputSchema(route.query) as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      out.push({
        name,
        in: "query",
        required: json.required?.includes(name) ?? false,
        schema,
        ...(schema["description"] ? { description: schema["description"] } : {}),
      });
    }
  }
  return out;
}

/** The record API's version: it changes with the API, not with each release of the service. */
export const API_VERSION = "1.0.0";

/** The OpenAPI 3.1 document of the record API, generated from the routes' own request schemas. */
export function openApiDocument() {
  const paths: Record<string, unknown> = {};
  for (const route of API_ROUTES) {
    paths[route.path] = {
      get: {
        operationId: route.operationId,
        summary: route.summary,
        parameters: parameters(route),
        // Anonymous reads are the public scope; the operator token widens
        // every route but the public emitters.
        security: route.alwaysPublic ? [{}] : [{}, { operatorToken: [] }],
        responses: {
          "200": {
            description: "OK",
            content: Object.fromEntries(route.produces.map((type) => [type, {}])),
          },
          ...(route.query || route.params ? { "400": { description: "Invalid request" } } : {}),
          "401": {
            description:
              "A bearer token other than the configured operator token (with none configured, a bearer token reads in public scope)",
            content: { "application/json": {} },
          },
          ...(route.notFound ? { "404": { description: "No such record, series or schema" } } : {}),
          // Every route but the health probe is rate-limited, the operator exempt.
          "429": {
            description: "The client's rate limit is spent; `Retry-After` says when to retry",
            content: { "application/json": {} },
          },
          ...(route.unavailable
            ? { "503": { description: route.unavailable, content: { "application/json": {} } } }
            : {}),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenConditions",
      version: API_VERSION,
      description:
        "Road conditions as model records. Collections are paginated by a keyset cursor: a walk is complete when `next` is null. A request without a bearer token reads in the public scope, which withholds restricted sources and licences that are not public; the operator token reads in the operator scope, which withholds nothing. The emitters always read in the public scope.",
    },
    components: {
      securitySchemes: {
        operatorToken: {
          type: "http",
          scheme: "bearer",
          description:
            "The instance's `OPENCONDITIONS_OPERATOR_TOKEN`: grants the operator scope and skips the rate limiter.",
        },
      },
    },
    paths,
  };
}
