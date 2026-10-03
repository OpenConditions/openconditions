import { z } from "zod";
import {
  AtQuery,
  FeatureListQuery,
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
}

const RecordId = z.string().min(1).describe("the record id, URL-encoded");

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
  },
  {
    path: "/situations.jsonld",
    operationId: "listSituationsJsonLd",
    summary: "Live situations as GeoJSON-LD (schema.org and SOSA context), one keyset page.",
    query: SituationListQuery,
    produces: ["application/ld+json"],
  },
  {
    path: "/traff.xml",
    operationId: "listSituationsTraff",
    summary:
      'Live situations as a TraFF 0.8 feed, one keyset page; `Link: rel="next"` names the next. Situations TraFF cannot tell without widening a vehicle condition are left out.',
    query: SituationListQuery,
    produces: ["application/xml"],
  },
  {
    path: "/datex2/situations.xml",
    operationId: "listSituationsDatex",
    summary:
      'Live situations as a DATEX II v3 SituationPublication, one record per effect, one keyset page; `Link: rel="next"` names the next. Not SRTI-profile-conformant.',
    query: SituationListQuery,
    produces: ["application/xml"],
  },
  {
    path: "/stream",
    operationId: "streamSituations",
    summary:
      "Server-sent events: every live matching situation, then each one that changes (`event: situation`) or goes (`event: remove`), polled every 15 s.",
    query: StreamQuery,
    produces: ["text/event-stream"],
  },
  {
    path: "/situations/{id}",
    operationId: "getSituation",
    summary:
      "One situation, tombstoned or not, with its evidence, the graph binding of its place (`binding`) and of each effect with a place of its own (`effectBindings`, by effect id).",
    query: AtQuery,
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/features",
    operationId: "listFeatures",
    summary:
      "Live features as records, one keyset page ordered by id; `canonical=1` serves one feature per cluster of linked features under its canonical id. Components only with `expand=components`.",
    query: FeatureListQuery,
    produces: ["application/json"],
  },
  {
    path: "/features.geojson",
    operationId: "listFeaturesGeoJson",
    summary: "Live features as a GeoJSON FeatureCollection, one keyset page.",
    query: FeatureListQuery,
    produces: ["application/geo+json"],
  },
  {
    path: "/features.jsonld",
    operationId: "listFeaturesJsonLd",
    summary: "Live features as GeoJSON-LD (schema.org and SOSA context), one keyset page.",
    query: FeatureListQuery,
    produces: ["application/ld+json"],
  },
  {
    path: "/features/{id}",
    operationId: "getFeature",
    summary:
      "One feature, tombstoned or not, with its components and the canonical cluster it belongs to; a canonical id serves the cluster's canonical feature.",
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/offers",
    operationId: "listOffers",
    summary: "Live offers (tariffs) as records, one keyset page ordered by id.",
    query: OfferListQuery,
    produces: ["application/json"],
  },
  {
    path: "/offers/{id}",
    operationId: "getOffer",
    summary: "One offer, tombstoned or not.",
    params: { id: RecordId },
    produces: ["application/json"],
    notFound: true,
  },
  {
    path: "/observations/latest",
    operationId: "listLatestObservations",
    summary:
      "The reading in effect of every matching series, one keyset page ordered by series (the cursor is a series id); `canonical=1` serves fused readings where several sources or the crowd report a property.",
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
      "Live records per country, subdivision, class, kind and access mode, and live series per property.",
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
        responses: {
          "200": {
            description: "OK",
            content: Object.fromEntries(route.produces.map((type) => [type, {}])),
          },
          ...(route.query || route.params ? { "400": { description: "Invalid request" } } : {}),
          ...(route.notFound ? { "404": { description: "No such record, series or schema" } } : {}),
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
        "Road conditions as model records. Collections are paginated by a keyset cursor: a walk is complete when `next` is null.",
    },
    paths,
  };
}
