import type { PinnedSet } from "../pinned.js";

/**
 * GeoJSON (RFC 7946): the JSON Schemas the geojson/schema repository
 * (https://github.com/geojson/schema) builds and serves at
 * https://geojson.org/schema/. That site follows the repository's `main`
 * branch, so the files are fetched from the repository's npm release
 * `geojson-schema@1.0.5` instead, which is byte-identical to the site on
 * 2026-10-17 and never changes.
 * The repository is under the MIT License (Copyright (c) 2018 Tim Schaub).
 * Each document is draft-07 and complete in itself, without `$ref`s to the
 * others.
 *
 * As the repository notes, the schemas cannot express that linear rings are
 * closed or follow the right-hand rule, nor RFC 7946's antimeridian cutting
 * and coordinate ranges; those are checked in code.
 */
const BASE = "https://unpkg.com/geojson-schema@1.0.5/";

export const GEOJSON: PinnedSet = {
  id: "geojson-rfc7946",
  files: [
    {
      name: "FeatureCollection.json",
      url: `${BASE}FeatureCollection.json`,
      sha256: "83e781f1513e447be9287b2180c300621f8b4c65245d7822a22fcf39431e0471",
    },
    {
      name: "Feature.json",
      url: `${BASE}Feature.json`,
      sha256: "3957840b2ff19f9450ea97a12f85944d938c68a7a6bf115a2e69b98e007b9922",
    },
    {
      name: "Geometry.json",
      url: `${BASE}Geometry.json`,
      sha256: "152369d7eb6b3314ffc7deca1d66f9d498ed5b614ca38ed4e2c813fed01024fd",
    },
    {
      name: "GeometryCollection.json",
      url: `${BASE}GeometryCollection.json`,
      sha256: "f33321639349bcb02300f560e5bb46bfc786cec2d6a5195778c5d480856e2e71",
    },
    {
      name: "Point.json",
      url: `${BASE}Point.json`,
      sha256: "35dd9cc5537e3a02a58ec63c22001508bd0c26036803f86004bb7cad0e9ad8b1",
    },
    {
      name: "MultiPoint.json",
      url: `${BASE}MultiPoint.json`,
      sha256: "402f60cda7dd391e4f1f596143a243a7360d2b7e6f01a7f26a32a773267ffb95",
    },
    {
      name: "LineString.json",
      url: `${BASE}LineString.json`,
      sha256: "38089f2d5b0ff4b14a3252266d12b589f5f0e7bcb6cf49558801065c9ed02ecb",
    },
    {
      name: "MultiLineString.json",
      url: `${BASE}MultiLineString.json`,
      sha256: "1ed66d341ae8220a0f969accf6783ce356bade856ab61691ee8c6c5b951e3764",
    },
    {
      name: "Polygon.json",
      url: `${BASE}Polygon.json`,
      sha256: "abff591832563d1343e8cacb5faaafe7b104560ac83d33d47b158446775c464a",
    },
    {
      name: "MultiPolygon.json",
      url: `${BASE}MultiPolygon.json`,
      sha256: "3d6e592c494264394e7252361b3e65acf4c31716a3d2106338dbcfb6f5fde55a",
    },
  ],
};
