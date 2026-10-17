import type { PinnedFile, PinnedSet } from "../pinned.js";

/**
 * WZDx (Work Zone Data Exchange): the JSON Schemas and example feeds of the
 * usdot-jpo-ode/wzdx repository (https://github.com/usdot-jpo-ode/wzdx), each
 * version taken from its own release tag. Retrieved 2026-10-17. The repository
 * is under CC0 1.0 Universal (its `LICENSE`), so nothing forbids copying, but
 * the schemas are fetched like every other standard's so the check is always
 * against the tagged upstream bytes.
 *
 * Version 3.1 is the one file `create-feed/schemas/wzdx_v3.1_feed.json` at tag
 * `v3.1`. Versions 4.0 to 4.2 split the feed over several files that `$ref`
 * each other by `$id`; 4.0 also has the RoadRestrictionFeed, which 4.1 removed
 * (4.1 and 4.2 still list the `restriction` EventType). The device feeds
 * (`SwzDeviceFeed`, `DeviceFeed`) are not pinned: no road-event parser reads
 * them.
 *
 * The 3.x and 4.x schemas `$ref` the GeoJSON geometry schemas served at
 * https://geojson.org/schema/ (built from https://github.com/geojson/schema,
 * MIT License), pinned here beside them from that repository's npm release
 * `geojson-schema@1.0.5`, which is byte-identical and, unlike the site,
 * never changes.
 */
const RAW = "https://raw.githubusercontent.com/usdot-jpo-ode/wzdx/";

const GEOJSON_GEOMETRIES: readonly PinnedFile[] = [
  {
    name: "geojson/LineString.json",
    url: "https://unpkg.com/geojson-schema@1.0.5/LineString.json",
    sha256: "38089f2d5b0ff4b14a3252266d12b589f5f0e7bcb6cf49558801065c9ed02ecb",
  },
  {
    name: "geojson/MultiPoint.json",
    url: "https://unpkg.com/geojson-schema@1.0.5/MultiPoint.json",
    sha256: "402f60cda7dd391e4f1f596143a243a7360d2b7e6f01a7f26a32a773267ffb95",
  },
];

/** A file of `schemas/<version>/` at the version's own release tag. */
const schema = (version: string, name: string, sha256: string): PinnedFile => ({
  name,
  url: `${RAW}v${version}/schemas/${version}/${name}`,
  sha256,
});

export const WZDX_V31: PinnedSet = {
  id: "wzdx-v3.1",
  files: [
    {
      name: "WZDxFeed.json",
      url: `${RAW}v3.1/create-feed/schemas/wzdx_v3.1_feed.json`,
      sha256: "6462cb1a3b33c8ca8879dca55f19c952480dc5e13a2142609062866524275c3e",
    },
    ...GEOJSON_GEOMETRIES,
  ],
};

export const WZDX_V40: PinnedSet = {
  id: "wzdx-v4.0",
  files: [
    schema(
      "4.0",
      "WZDxFeed.json",
      "38a0a3602f14d56375c6b109599ec9d659d5c4fff818a71a3b982e3d33f16f2d",
    ),
    schema(
      "4.0",
      "RoadRestrictionFeed.json",
      "faaf9c86e0d2be1ad5a67ebc09a9a5779a85e81524debdf8ab37d6e79a9e4c12",
    ),
    schema(
      "4.0",
      "RoadEventFeature.json",
      "d2d6c7612fb8e694999ab26b184adb2becd96f6027009573d286157fb4642029",
    ),
    schema(
      "4.0",
      "FeedInfo.json",
      "ff1db09f59138fe8c00d8c954df4915f910abcf9f0166543addb7b36fdc9435f",
    ),
    schema(
      "4.0",
      "BoundingBox.json",
      "1e1fa8f769dadd4a5b324c54ced166abeea44a019f893460c915bf1f115897ce",
    ),
    ...GEOJSON_GEOMETRIES,
  ],
};

export const WZDX_V41: PinnedSet = {
  id: "wzdx-v4.1",
  files: [
    schema(
      "4.1",
      "WorkZoneFeed.json",
      "c62512a35cb3e749baf2bc60d046e9d27a5aaed3e82cc94b579c2cd2ca10334d",
    ),
    schema(
      "4.1",
      "RoadEventFeature.json",
      "5fc67f19e336f3341efa76da9f846c8d22b04ebace2fc9bd7bbd5c34ecfbcfc2",
    ),
    schema(
      "4.1",
      "FeedInfo.json",
      "a77f24f6c6df7af73bc01a5a9199becda95a84b15023d9c9b8fbc9671ef3c49a",
    ),
    schema(
      "4.1",
      "Direction.json",
      "7507aba18f76362d184e272f43cb3965a6cbb5b292dcc788f7c6696301d91584",
    ),
    schema(
      "4.1",
      "BoundingBox.json",
      "a09daed8b43d36827555a8258e1c3e70b6738330b365d9d93c4310190f9bb512",
    ),
    ...GEOJSON_GEOMETRIES,
  ],
};

export const WZDX_V42: PinnedSet = {
  id: "wzdx-v4.2",
  files: [
    schema(
      "4.2",
      "WorkZoneFeed.json",
      "81e575ec9c7016fdb73674b5bdd42824c4dd6a1268afc42e75ce2dd1550138c7",
    ),
    schema(
      "4.2",
      "RoadEventFeature.json",
      "2f9bff85b5468bcabf0fc53b499cff1ec696495097c5e462e81f1fd8673509af",
    ),
    schema(
      "4.2",
      "FeedInfo.json",
      "4bdb7d76249397f5ae410b70fe9b7dfe705635ba381257530aae412d93b87e74",
    ),
    schema(
      "4.2",
      "Direction.json",
      "98cbd07ca39d7d09f790e028ec8f6363a3dad6fbe82f98572791986fb3af0a73",
    ),
    schema(
      "4.2",
      "BoundingBox.json",
      "a5233aacea34f6a9789fc008008879792b20921461201c795533e461225babda",
    ),
    ...GEOJSON_GEOMETRIES,
  ],
};

/** The root schema of a version's work zone feed, by the file name its set pins it under. */
export const WZDX_FEED_SCHEMA: Readonly<Record<string, string>> = {
  "3.1": "WZDxFeed.json",
  "4.0": "WZDxFeed.json",
  "4.1": "WorkZoneFeed.json",
  "4.2": "WorkZoneFeed.json",
};

/** The 4.0 RoadRestrictionFeed's root schema, in {@link WZDX_V40}. */
export const WZDX_ROAD_RESTRICTION_FEED_SCHEMA = "RoadRestrictionFeed.json";

/** An `examples/` feed at a release tag. */
const example = (tag: string, path: string, sha256: string): PinnedFile => ({
  name: path,
  url: `${RAW}${tag}/${path}`,
  sha256,
});

/**
 * The official example feeds of each release tag, named by their path in the
 * repository. Tag `v3.1` has no 3.1 examples: its two `create-feed/examples`
 * feeds declare version 3.0. Tag `v4.1`'s WorkZoneFeed examples give the
 * position-verification booleans as strings, which the 4.1 schema refuses;
 * upstream fixed them in "Fix Work Zone Feed example GeoJSON files (#344)",
 * after the release.
 */
export const WZDX_EXAMPLES: Readonly<Record<string, PinnedSet>> = {
  "3.0": {
    id: "wzdx-examples-v3.1-tag",
    files: [
      example(
        "v3.1",
        "create-feed/examples/linestring_example.geojson",
        "6b150496f462b48d349d902cfb7478d17d371f5b33b1c4a7d7d15f68c722e367",
      ),
      example(
        "v3.1",
        "create-feed/examples/multipoint_example.geojson",
        "82130cdc8cea606be99f59cb107ed4604b13b2c55dc3fa4ac54c7cf7ff475a7a",
      ),
    ],
  },
  "4.0": {
    id: "wzdx-examples-v4.0",
    files: [
      example(
        "v4.0",
        "examples/RoadRestrictionFeed/bridge_height_restriction_linestring_example.geojson",
        "9bda667f639b00c59da101e73e219ade0c64437921709479d0bca359a47ebf7c",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/local_access_only_bidirectional_linestring_example.geojson",
        "4fa96cec27ece051e3e005844116d1e5a17404260eac63a3ce6169b216374ee2",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario1_simple_linestring_example.geojson",
        "eb9b8883eaab5da1839b2bce11e95d90c70e6b5a900a9d4703fd0a12cbb7c347",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario1_simple_multipoint_example.geojson",
        "b0fc0e45d0b14d03fd0e430201abbeac67cbe1f1de4617d3f4b5defe757dd75b",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario2_laneshift_linestring_example.geojson",
        "442233827675c16f621d3c4c1fe1396492244cbd557399b9f3292adccff9fd85",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario3_shoulder_bidirectional_linestring_example.geojson",
        "b58f7cacea0d5d84c58b17e03815536fb34fdf73458cb0c2826b2be5af2d1995",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario4_detour_linestring_example.geojson",
        "7932c027c13d71174692a0ac91bd9090d2a625ba380ab2ebd653ad73e81e8a5c",
      ),
      example(
        "v4.0",
        "examples/WZDxFeed/scenario5_recurring_linestring_example.geojson",
        "3c79547997c613a7ea04cbfcad0f1b80d30a43137b2b2a93836eb6b0b4a7310c",
      ),
    ],
  },
  "4.1": {
    id: "wzdx-examples-v4.1",
    files: [
      example(
        "v4.1",
        "examples/WorkZoneFeed/local_access_only_bidirectional_linestring_example.geojson",
        "e8e8497790c724de9fbc67937610532201ccd1c4d439a41f9949371bbb3a0d0d",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario1_simple_linestring_example.geojson",
        "fe67112d40a4825b796894fda4d4cdbe28fef21ae5714068822e6c063c6428d8",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario1_simple_multipoint_example.geojson",
        "e9cf09a695696ba5598a8cef3e2ec190e174f37b8faad3c101c3e9b4de5d06b6",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario2_laneshift_linestring_example.geojson",
        "901862e603644b0e56e0c30d218760cddbac0916161a171c5ba37dde235c577c",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario3_shoulder_bidirectional_linestring_example.geojson",
        "02c7538dd11e0ef6b7cc64b623b0bd42e72e9e7e523db71a999ba73212611eca",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario4_detour_linestring_example.geojson",
        "8fd271a2c9d284f954e4de63800a5aeec94e3e9f5b693302b45ce07851566899",
      ),
      example(
        "v4.1",
        "examples/WorkZoneFeed/scenario5_recurring_linestring_example.geojson",
        "415a041e2d2f4b06658dac6aa83bf2496724376f46d2819f08db9fab14d1fb6b",
      ),
    ],
  },
  "4.2": {
    id: "wzdx-examples-v4.2",
    files: [
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario1_simple_linestring_example.geojson",
        "143c0c253364a223e4984cbd885a356246dc27608ccd77b9c92f410dad8526ee",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario1_simple_multipoint_example.geojson",
        "0498fe0427bec7065928d398d614f411011e9493f568a3f656aeb5ddee9b9595",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario2_laneshift_linestring_example.geojson",
        "27635aac1e67c8340e5c5e02d6dacf333280854a184b631dcd7dc9badf49c8ed",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario3_shoulder_bidirectional_linestring_example.geojson",
        "b7cf9efacea9810230f00b3864403c88d1f8788dfad6cc4ea111b1a2322c0758",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario4_detour_linestring_example.geojson",
        "a425c9181c75a58ffee8bdd872801c6d5e704a081407b26520953f093542ae39",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario5_recurring_linestring_example.geojson",
        "2de71899b9f141647a02cbecf551dba74d57ed065cba294a0f268d2c6e056942",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario6_multi_lane_closure_linestring_example.geojson",
        "909c5282add50630cf46fe7732644e835ea0bce26c1802b9756b2cb2ab126081",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario7_mobileoperation_linestring_example.geojson",
        "20b08febeb96e76acfdac8f5551093e942fb7d5f820010bc82c9bbe177c466d3",
      ),
      example(
        "v4.2",
        "examples/WorkZoneFeed/scenario8_local_access_only_bidirectional_linestring_example.geojson",
        "df9f5f876cdc981a36ebfa1991b60dcb6919a212742db96ec81b40c4c9359a4c",
      ),
    ],
  },
};
