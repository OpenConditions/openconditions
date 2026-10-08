# Feed catalogue

Every feed OpenConditions ingests is written here as data. The ingest service
reads this directory at startup, checks it as a whole, and polls what it holds.
Adding or fixing a feed is an edit to one region file; no code changes.

## Layout

```
feeds/
  credentials.jsonc        credential fields shared by several feeds
  roads/                   one directory per domain
    de.jsonc               one file per region
    nl.jsonc
    …
  fuel/
    de.jsonc
    es.jsonc
    global.jsonc
    …
  parking/
    de.jsonc
    nl.jsonc
    global.jsonc
    …
  charging/
    de.jsonc
    fr.jsonc
    global.jsonc
    …
  schema/                  generated JSON Schemas (do not edit)
    roads.schema.json
    fuel.schema.json
    parking.schema.json
    charging.schema.json
    credentials.schema.json
```

A domain directory holds region files named for what they cover: an ISO 3166-1
alpha-2 code in lower case (`de`, `us`), `eu` for a pan-European feed, or
`global`. A directory that names no known domain is an error, and so is any
other file in a domain directory; hidden files (`.DS_Store`) are skipped.

## Region files

A region file is JSONC (comments and trailing commas allowed):

```jsonc
{
  "$schema": "../schema/roads.schema.json",
  "maintainers": [{ "name": "…", "github": "…" }],
  "feeds": [
    {
      "subdivision": "hh",
      "operator": "polizei",
      "product": "events",
      "name": "Polizei Hamburg traffic incidents (Landesmeldestelle)",
      "tier": "authoritative",
      "format": "geojson",
      "endpoints": {
        "main": { "url": "https://api.hamburg.de/…", "cadenceSec": 300 },
      },
      "geojson": { "idField": "id", "typeField": "art" },
      "freshnessWindowSec": 900,
      "license": "DL-DE-BY-2.0",
      "licenseUrl": "https://www.govdata.de/dl-de/by-2-0",
      "attribution": "Freie und Hansestadt Hamburg, Polizei Hamburg",
      "privacyUrl": "https://www.hamburg.de/datenschutz/",
    },
  ],
}
```

`$schema` is required and must be `../schema/<domain>.schema.json`; editors use it
to complete and check fields. `maintainers` is optional. The fields every feed
shares are defined in `packages/ingest-framework/src/catalog/schema.ts`; a domain
adds its own (roads: `geojson`, `flowMap`, `posListLonLat`, `srsName`, `bbox`,
`openlrResolver`, `laneNumbering`, in `packages/roads/src/feed-schema.ts`;
parking: `layout` and `parking`, in `packages/parking/src/feed-schema.ts`;
charging: `layout` and `charging`, in `packages/charging/src/feed-schema.ts`; see
[Generic layouts](#generic-layouts)) or none (fuel).

`tier` is `authoritative` for the publishing authority and `aggregator` for a
relay of others' data. `freshnessWindowSec` is how old the last good poll may
get before the feed is reported stale. `snapshot` declares a publication that
is the publisher's complete current set, so a record missing from it is
withdrawn.

The other optional fields every feed may carry:

- `accessMode`: `bulk` (the default; each poll fetches the published set) or
  `on_demand` (the publisher answers queries), stamped on each record's
  provenance.
- `homepage`: the publisher's site (an https URL), where consumers link the
  feed's attribution. Left out, it is the `https` origin of the feed's first
  data endpoint URL, read off the URL as written, so a credential never reaches
  it; reference data (endpoints with a `decoder`) is skipped. Write it when the
  data host is not the publisher's site (an API host), or when the URL is not
  `https` on the default port or has a placeholder in its host: a credential,
  or a shared group of settings such as `${@overpass.url}`, whose base is the
  instance's own service (perhaps self-hosted, perhaps plain http) and no
  credit link (`feeds:lint` reports those). `GET /sources` serves it.
- `requestLimits`: the publisher's stated limits, `perMinute`, `perDay`,
  `maxRadiusKm` and `keyScope` (`instance` or `consumer`: whom one key serves).
  `perMinute` and `perDay` count upstream requests: an on-demand cell of a
  data endpoint with several `urls` spends one per URL. A polled feed with
  `perMinute` is paced to it: its requests, across all its roles, a fan-out's
  URLs and a paginated endpoint's pages, start at most `perMinute` times in any
  60 seconds, waiting their turn rather than failing. A followed URL is not
  counted.
- `extrasAllow`: the source fields kept on each record under `extras`.
- `extrasFederate`: whether those extras are sent to federation peers
  (default `false`).
- `rawRetention`: the class raw payloads are archived under, `situation`,
  `observation` or `reference`; by default the format's (`observation` for a
  measurements format, else `situation`), and only when the rights grant
  retention.

`coverage` says where a feed's data lies: `countries`, a list of upper-case
codes, and `bbox`, `[west, south, east, north]` in degrees. A national feed
covers its country (`["DE"]`); a narrower one names the ISO 3166-2
subdivisions it covers (`["DE-BY"]`, `["US-NY"]`). Left out, a feed in a
country's region file covers that country, and one in `eu.jsonc` or
`global.jsonc` covers nothing in particular. `GET /sources` serves each feed's
coverage, so a consumer can tell which areas a feed stands for (a global
on-demand feed's box is the world).

## Feed ids

A feed's id is derived, never written:

```
[region, subdivision, operator, qualifier, product].filter(Boolean).join("-")
```

The region comes from the file name and is left out for `global`. Every token is
lower-case `[a-z0-9]+`. `subdivision` is an ISO 3166-2 subdivision or a city
slug; `operator` names the publisher, or the platform when the platform is what
publishes the regional bundle (the `de-*-mobilithek-events` feeds are
Mobilithek's per-state collections, not one authority's feed); `product` is
what the feed publishes. The roads products are:

| product      | what                                                     |
| ------------ | -------------------------------------------------------- |
| `events`     | situations: incidents, roadworks, closures, restrictions |
| `conditions` | road and weather conditions along road segments          |
| `flow`       | measured traffic: speed, volume, level of service        |

The fuel product is:

| product | what                                                                          |
| ------- | ----------------------------------------------------------------------------- |
| `fuel`  | filling stations, the grades they sell, their prices and what is out of stock |

A fuel format is a `features` format. A bulk feed's poll is the publisher's
complete set of stations, so a station missing from it is withdrawn: `minetur`
(Spain) and `prix-carburants` (France). The others are read on demand (see
below), each answer for one cell: `tankerkoenig` (Germany), `econtrol`
(Austria) and `overpass` (OpenStreetMap, worldwide). The formats are in
`packages/fuel/src/domain.ts`.

The parking product is:

| product   | what                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `parking` | car parks, garages and lorry parks, their spaces by kind, live occupancy and tariffs |

Every parking format is a `features` format. A publisher whose payload is a
plain GeoJSON, JSON or CSV table is written in the generic layout of that name
(`geojson`, `json`, `csv`) with a `layout` block and a `parking` mapping, so it
needs no code. A standard or a publisher's own API has a format of its own:
`datex2` (DATEX II v2 or v3 site table and status), `datex2-light` (DATEX II
Light JSON), `parkapi-v3`, `db-bahnpark`, `rdw`, `sbb`, `opendatahub`, `hdb`,
`utmc`, `tfnsw` and `overpass` (OpenStreetMap, on demand). The formats are in
`packages/parking/src/domain.ts`.

The charging product is:

| product    | what                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| `charging` | charging sites, their charge points (EVSEs) and connectors, live charge-point status, tariffs |

Every charging format is a `features` format. A plain GeoJSON, JSON or CSV
table is written in the generic layout of that name with a `layout` block and a
`charging` mapping. The standards have a format each: `ocpi` (OCPI 2.2/2.3
locations, EVSE status, tariffs, and OCPDB's tariff associations and sources),
`oicp` (OICP EVSE data and status files), `datex2` (DATEX II v3 energy
infrastructure table and status) and `overpass` (OpenStreetMap, on demand). A
publisher's own API or file has a format of its own: `digitraffic`, `bnetza`,
`irve`, `afdc`, `nobil`, `eipa`, `cynap`, `chargy`, `evroam`, `keco`, `lta`,
`tdx` and `ocm` (Open Charge Map, on demand). The formats are in
`packages/charging/src/domain.ts`.

`qualifier` (one or more dash-joined tokens) tells apart two feeds that would
otherwise share an id: `ca-on-511-construction-events` beside
`ca-on-511-events`, `de-nw-autobahn-los-flow` beside `de-nw-autobahn-flow`.
Leave it out when the id is unique without it. An id, once published, does not
change: it names the feed's records, its status and its credentials.

## Endpoints and decoders

`endpoints` maps a role to what is fetched. Every feed has `main`, the data it
publishes. A format may declare more roles; the roads measurement formats that
place readings by site id declare `sites`, the reference data that gives each
site its geometry.

An endpoint has exactly one of:

- `url`: one URL;
- `urls`: several URLs whose payloads are parsed together;
- `reference`: a published file found by name (`{ "kind": "mobilithek",
"offerId": "…", "fileNamePrefix": "…" }`), always with a `decoder`.

and `cadenceSec`, how often it is fetched. Reference endpoints refresh every six
hours (`21600`). The optional request fields are `method`, `body`, `headers`,
`gzip` (the body is gzipped), `pagination` (`skipParam`, `pageSize`,
`recordsPath`, `maxPages`; `mode`, `"offset"` by default, or `"page"` where
`skipParam` carries a page number counted from `firstPage`, 1 by default;
`xmlLists: true` for JSON converted from XML, where a list of one is the item
itself and an empty last page has no list),
`follow`, `impersonate`, `expand` (see credentials) and `fanout`, for an
endpoint of several URLs (`urls` or `expand`): `"all"`, the default, needs every
URL to answer, so one failure fails the poll; `"tolerant"` costs only the
failing URL's records, and sends no conditional requests.

`follow` is for a URL that answers with the address of the data rather than the
data: a download page that links the CSV, a batch call that returns a presigned
link. It has exactly one of `path` (a dotted JSON path; a numeric segment
indexes an array, as in `value.0.Link`) or `pattern` (a regular expression whose
first group is the URL). The URL found is resolved against the page URL and
fetched next, and that body is the payload. The followed request is a GET that
carries the endpoint's `headers` except any whose value names a credential
(`${field}`), and none of the feed's auth, whatever its kind. It passes the
same egress checks as any request. A page without a match fails the fetch. A
followed endpoint is fetched in full every time and cannot be paginated.

`impersonate: true` sends the request with a browser's TLS and HTTP fingerprint,
for an upstream whose bot protection refuses ordinary clients. It needs `https`
URLs, cannot be combined with `mtls` auth, and keeps the egress checks: private
addresses are refused by name and by DNS on every hop, and the body is capped.

A parking format that reads a site table and the live state of its sites
declares `sites` and `status` in place of `main` (`datex2`, `opendatahub`,
`hdb`, `utmc`); each is fetched at its own cadence, and a role that fails while
an earlier payload of it is held is parsed with that payload, so a failing
daily site table never stops the occupancy. `parkapi-v3` declares `main` and
`sources` (the upstream sources that type and credit the sites), `rdw` declares
`specs` and `areas`.

A charging format reads its sites from `main` and may declare more roles, each
optional: `status` (the live charge-point states, where they come apart from
the sites: `ocpi`, `oicp`, `datex2`, `digitraffic`, `irve`, `keco`), `tariffs`
(`ocpi`, `digitraffic`), and OCPDB's `associations` and `sources` (`ocpi`).
`tdx` reads `sites`, `tariffs` and `status`; `eipa` reads the register's files
as `pools`, `stations` and `points` (required), `operators`, `dictionary` and
`status`.

`decoder` names how a reference endpoint is read. The roads decoders are
`datex2-sites` (a DATEX II measurement site table), `datex2-locations` (DATEX II
predefined locations) and the station registries `fintraffic-stations`,
`webtris-sites`, `miv-config`, `france-comptage-csv`, `hk-detector-csv` and
`bcn-trams-csv`. A format accepts only the roles and decoders it declares
(`packages/roads/src/domain.ts`); anything else is a lint error.

## Credentials

A feed declares the secrets it needs under `credentials`, by field name, with a
title and an optional `description` and `setup` guide (`url`, `urlLabel`,
`steps`, `cost`, `notes`, `email`) that the admin panel renders. A field may be
`optional` or carry a `default` (QLDTraffic ships the publisher's public key).
Field names say what the value is: `api_key`, `user`, `password`,
`subscription_id`, `sites_subscription_id`, `client_id`, `client_secret`.

A field is used by `auth` or as a `${field}` placeholder in a URL, body or header:

```jsonc
"credentials": { "api_key": { "title": "Tark Tee key (Estonia)" } },
"auth": { "kind": "query-key", "param": "apiKey", "credential": "api_key" },
```

The auth kinds are `none`, `query-key`, `header-key` (with an optional
`valuePrefix`), `basic`, `bearer`, `oauth2-client-credentials` and `mtls`.
`expand` names a field whose value is a comma-separated list: the endpoint's URL
is filled once per item (one Mobilithek client pull per subscription id), and an
unset value means no URLs, so the feed stays dormant until it is configured.

One account that serves several feeds is declared once, in `credentials.jsonc`,
as a shared group, and referred to as `@<group>.<field>`:

```jsonc
"auth": { "kind": "mtls", "cert": "@mobilithek.cert", "key": "@mobilithek.key" },
```

A group is named after the account or portal that issues the credential, not
after the feeds that use it: `mobilithek` (the org machine certificate every
Mobilithek feed uses), `au-vic-transportvic` (the Transport Victoria open-data
portal key that both the `vicroads` and the `transportvic` feeds use),
`us-oh-ohgo`, `hr-hc`, …; a regional issuer's group is `<region>-<issuer>`. A
group serves at least two feeds; a credential one feed uses stays on that feed.

A group whose every field has a `default` holds instance settings rather than
an account, and may serve a single feed: `overpass.url` is where this instance
reaches Overpass (the public interpreter by default), read by every
OpenStreetMap source as `${@overpass.url}/api/interpreter`.

A setting is a base URL, which carries no query or fragment. Its trailing
slashes are dropped, and when the template follows it with a path the value
already ends with, that path is not written twice: `http://overpass:80`,
`http://overpass:80/` and `http://overpass:80/api/interpreter` all fill
`${@overpass.url}/api/interpreter` as `http://overpass:80/api/interpreter`.
A value with a query or fragment is taken as written, apart from its trailing
slashes. The road-graph import and the maxspeed lookup build their URL by the
same rule. A feed's own credentials and the fields of an account group are
filled verbatim.

`pnpm gen:credentials` writes each setting into `services/ingest/service.json`
as a non-secret `configSchema` field with its `default`, beside the
credentials' secret fields and the service's own fields (`SERVICE_FIELDS` in
`scripts/lib/gen-credentials-lib.ts`: `DATABASE_URL`, the operator token, rate
limits and the like); `pnpm check-credentials` checks it. Under OpenMapX
the operator sets it as the service's config: in the admin services panel, or
as `SERVICE_OPENCONDITIONS_INGEST_<NAME>` in OpenMapX's `.env`
(`SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL`). Settings kept in OpenMapX's
`.env` are applied with `pnpm openmapx services start openconditions-ingest`
(which resets every setting saved only in the admin form, so keep all of them
in one place). Settings saved in the form are applied with **Save & Apply**.
OpenMapX writes a `${VAR}` in a
community service's `container.environment` as a literal, so a setting is never
passed through there, and the generator fails on an environment entry that
names any config field. A private Overpass host also needs
`OPENCONDITIONS_EGRESS_ALLOWED_HOSTS`.

Each credential is read from an environment variable (or `<NAME>_FILE`): a
feed's own field from `<FEED_ID>_<FIELD>`, a shared field from
`<GROUP>_<FIELD>`, upper-cased with `-` as `_`. So `de-hh-autobahn-flow`'s
`subscription_id` is `DE_HH_AUTOBAHN_FLOW_SUBSCRIPTION_ID`, and
`@mobilithek.cert` is `MOBILITHEK_CERT`. A catalogue child uses its parent's
names.

## Licences and terms

`license` is an SPDX identifier where SPDX lists the licence (`CC-BY-4.0`,
`ODbL-1.0`, `DL-DE-BY-2.0`), otherwise `LicenseRef-<name>`
(`LicenseRef-GeoNutzV`), matched exactly. The ids the catalogue accepts, and the
rights each grants, are in `packages/ingest-framework/src/catalog/licenses.ts`.
A feed with no known licence is `NOASSERTION` and must say what is known in
`terms`.

`terms` records a feed's own terms where they differ from its licence: `url`,
`reviewedAt`, `note`, and any of `redistribution`, `derivedRedistribution`,
`commercialUse`, `attributionRequired`, `retention`. A key set in `terms`
(even to `null`) overrides the licence; an absent key defers to it.

## On-demand feeds

A publisher that answers queries by place rather than publishing its whole set
is written as an on-demand feed. Nothing polls it: a read of a bounding box
fetches the grid cells that cover the box, and the answer is kept for a while.

```jsonc
{
  "operator": "…",
  "product": "fuel",
  "accessMode": "on_demand",
  "onDemand": { "cellDeg": 0.25, "ttlSec": 900, "maxCellsPerRead": 4, "probe": [13.4, 52.52] },
  "requestLimits": { "perMinute": 1, "maxRadiusKm": 25 },
  "coverage": { "bbox": [5.8, 47.2, 15.1, 55.1] },
  "endpoints": {
    "main": { "url": "https://…/list?lat={lat}&lng={lon}&rad={radiusKm}", "cadenceSec": 900 },
  },
  …
}
```

- `onDemand.cellDeg` is the cell size in degrees. The grid is anchored at 0°,
  0°, so a place is always the same cell.
- `onDemand.ttlSec` is how long a cell's answer is current; each record of it
  expires then.
- `onDemand.maxCellsPerRead` caps the cells one read may cover, fresh or
  stale: a read whose area covers more cells fetches none of them, not even
  the stale ones, and is answered from what is already held (coverage reason
  `too_many_cells`).
- `onDemand.probe` is the `[lon, lat]` whose cell `feeds:check` fetches. It lies
  inside `coverage.bbox`.
- `coverage.bbox` is required: a read outside it never fetches.
- The data endpoint fills a cell into its URL, body or headers with
  `{west}`, `{south}`, `{east}`, `{north}` (the cell's edges), `{lat}` and
  `{lon}` (its centre) and `{radiusKm}` (centre to farthest corner). `${field}`
  stays a credential. A bulk feed may not use these placeholders.
- `requestLimits.maxRadiusKm`, when set, must reach a whole cell.
- The format is a `features` format that declares what it `produces` (feature
  kinds and properties), so a read fetches only the feeds that can answer it.

## Generic layouts

A parking feed in the `geojson`, `json` or `csv` layout is read through two
blocks, both required (`feeds:lint` reports a missing one):

```jsonc
"format": "csv",
"layout": { "delimiter": ";", "encoding": "latin1", "lon": "LONGITUD", "lat": "LATITUD" },
"parking": {
  "id": "PK",
  "name": ["NOMBRE"],
  "lang": "es",
  "defaultType": "off_street",
  "capacity": { "field": "DESCRIPCION", "pattern": "Plazas:\\s*(\\d+)" },
  "address": { "street": "NOMBRE-VIA", "houseNumber": "NUM", "postalCode": "CODIGO-POSTAL" },
},
```

`layout` cuts the payload into records and places each:

- `records`: the path of the record array (GeoJSON: `features`; JSON: the root);
- `lon` and `lat`: the coordinate fields, or `point`, one field holding both
  (`{ "field": "Geo Point", "order": "latlon" }`, a `"a,b"` string or an array);
  a GeoJSON record without them takes its geometry's point, a JSON record the
  geometry at `geometryPath`;
- `crs`: the geometry's CRS when the payload does not name it (`EPSG:31468`);
- CSV only: `delimiter` (default `,`), `encoding` (`utf-8` or `latin1`) and
  `decimalComma`.

`parking` maps a record onto a parking site. Every value is a field reference:
a dotted path into the record (`addresses.0.zip_code`; a GeoJSON record is its
`properties`), or `{ "field", "pattern" }`, whose regular expression's first
capture group is the value. The members:

| member                                    | what                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`                                      | the publisher's id of the site (required)                                                              |
| `name`, `lang`                            | name candidates, the first non-empty wins; the language of the texts                                   |
| `type`, `defaultType`                     | the site type through a value map (`park_and_ride`, `off_street`, …), else the default                 |
| `layout`, `defaultLayout`                 | the structure (`multi_storey`, `underground`, `surface`, …) through a value map, else the default      |
| `capacity`, `available`, `occupied`       | the counts; `available` is derived from the other two when absent                                      |
| `status`, `trend`                         | value maps onto `parking.status` and `parking.trend`; `status` may be a list, the first that maps wins |
| `updated`                                 | when the counts were measured: ISO or `d.m.y h:m` in the required `timezone`; undated is no reading    |
| `liveWhen`                                | readings only when this `{ field, equals }` holds                                                      |
| `address`, `operator`, `website`, `notes` | site details                                                                                           |
| `openingHours`, `tariffText`              | opening hours (`syntax`: `osm` or `text`) and tariff text                                              |
| `free`, `heightLimit`                     | free of charge when the condition holds; the height limit in `m` or `cm`                               |
| `areas`                                   | spaces by vehicle type and user group, each with a `capacity` field or a `presentWhen` condition       |
| `rates`                                   | priced rows of one tariff, each a flat price with an optional `maxDuration`, in `currency`             |
| `filter`                                  | the records kept: each filter's field among `include`, not among `exclude`                             |

The value maps hold the closed vocabularies, so the generated schema lists the
values an editor may write. A count is never invented: a negative, unreadable
or impossible count gives no reading, and a source that only says a site has
disabled spaces gives an area without a capacity.

A charging feed in a generic layout is read the same way, through `layout` and
a `charging` mapping, both required. `layout` may also name `wkt`, a field
holding a WKT point (in `crs` when it is not WGS 84). Records sharing an id form
one site, whose own fields come from the first:

```jsonc
"format": "csv",
"layout": { "delimiter": ";", "wkt": "WKT_GEOM", "crs": "EPSG:31370" },
"charging": {
  "id": "EMPLACEMENT_ID",
  "lang": "fr",
  "operator": "OPERATEUR",
  "address": { "street": "ADRESSE", "postalCode": "CODE_POSTAL", "city": "VILLE" },
  "evse": { "key": "CONNECTEUR_ID" },
  "connectors": { "row": { "powerKw": { "field": "PUISSANCE_KW", "unit": "kW" } } },
},
```

| member                                    | what                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                                      | the publisher's id of the site, or a list of fields joined into one (required)                                           |
| `name`, `lang`                            | name candidates, the first non-empty wins; the language of the texts                                                     |
| `operator`, `website`, `address`, `notes` | site details                                                                                                             |
| `openingHours`, `tariffText`              | opening hours (`syntax`: `osm` or `text`) and tariff text                                                                |
| `audience`, `lifecycle`, `parkingType`    | value maps onto the site's audience, lifecycle and OCPI parking type                                                     |
| `completion`                              | when building finishes (`31/07/2023`, `30 November 2023`, `November 2023`): a later date than the fetch is planned       |
| `evse`                                    | which records are one charge point (`key`) and its eMI3 id (`evseId`); without it each connector is its own charge point |
| `connectors`                              | exactly one of `row`, `columns` and `list` (below) (required)                                                            |
| `filter`                                  | the records kept, as for parking                                                                                         |

`connectors` says how a record names what it offers:

- `row`: one connector per record, with `standard` (OCPI `ConnectorType` codes,
  or a value map), `format`, `current`, `powerType`, `powerKw` (in `kW` or `W`)
  and `count` (a charge point standing for that many identical ones);
- `columns`: a count column per kind of charge point (`standard`, `current`,
  `format`, `powerKw`), each count above zero one group of charge points;
- `list`: a text split on `separator` into parts matching `pattern`, whose
  named groups `count`, `type` and `power` are read; each part is a group of
  charge points (`as: "evses"`, the default) or one connector type of every
  charge point (`as: "connectors"`, the charge points then being the parts of
  the `groups` text).

A plug count is never read as a charge-point count, and a power range is not a
rating: a source that does not say gives no value.

## Disabled feeds

A dead or blocked feed stays documented in its region file:

```jsonc
"disabled": { "reason": "publisher withdrew the open endpoint", "since": "2026-09-30" },
```

It is checked like any other feed but never polled, and `/feeds/status` lists it
with its reason. A disabled feed still names an implemented format, so only a
source an existing format reads is written as one. The sources that cannot be
run, and need no entry, are listed under
[Sources not taken](#sources-not-taken).

## Sources not taken

Parking sources considered and left out, reviewed on 2026-10-05. Taking one
needs the change its reason names.

| source                                                              | reason                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ParkenDD ParkAPI v2 (`api.parkendd.de`)                             | No data licence for 23 of its 28 cities (it scrapes operator pages), and its scraper has been frozen since 2026-07-18.   |
| Autobahn GmbH rest areas (`verkehr.autobahn.de` `parking_lorry`)    | No published licence or terms. The same lorry parks come live and licensed from `de-bw-mobidata-parking` (Toll Collect). |
| Stadtwerke Bamberg car park counter                                 | The imprint requires written consent, and the records carry no coordinates.                                              |
| Stadtwerke Trier `parken-v2.xml`                                    | The imprint requires written consent, and the records carry no coordinates.                                              |
| APCOA, GOLDBECK and APAG on Mobidrom, Bielefeld WFS, Düsseldorf WFS | Exact subsets of `de-nw-mobidrom-parking`.                                                                               |

Charging sources considered and left out, reviewed on 2026-10-06.

| source                                         | reason                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-Control Ladestellenverzeichnis API (Austria) | The API terms forbid modifying the data and passing it on as a file or webservice, and bind each user to logo, visitor reporting and a €10,000 penalty per breach. |
| PUN ArcGIS layer (Italy)                       | No licence or terms anywhere, and the layer has been frozen since 2024-09-19; the live PUN API is a private web-app backend.                                       |
| ESB ecars CSV (Ireland)                        | Unchanged since 2024-12-20 despite a quarterly schedule, with out-of-date prices. Ireland's AFIR access point (OCPI via TII) will replace it.                      |
| TMR Queensland `csl_ev.csv`                    | Unchanged since 2022-12-06, 17 sites.                                                                                                                              |
| Hong Kong EPD app JSON (`evca_ver_1_0.json`)   | The EV-Charging Easy app's backend: no published dataset, licence or terms. The licensed CSDI copy is taken (`hk-epd-charging`).                                   |
| data.go.kr EV "standard data" download         | Frozen at 2020-10-28, municipal stations only. The KECO OpenAPI is taken (`kr-keco-charging`).                                                                     |

## Catalogue resolvers

A feed with `catalog` is a registry of feeds rather than one feed:
`catalog.resolver` names the domain resolver that enumerates its children (roads:
`autobahn-index`, `wzdx-registry`), and `endpoints.main.url` is the registry it
reads, the only place its URL is written. A resolver serves one parent: its
snapshot and approved children are the resolver's. Children are named by their
qualifier under the parent's region, subdivision, operator and product (`de-autobahn-a1-warning-events`,
`us-wzdx-fe9b3423ea03546f-events`) and inherit every field they leave out.
Without `approvedChildren` the parent fans its children out at fetch time; with
it, only the listed children are polled and the rest are shown to operators as
discovered. Each resolver keeps a vendored snapshot it falls back to when the
registry is down.

## Checking the catalogue

```sh
pnpm feeds:lint                       # schema, ids, formats, credentials, licences, URLs
pnpm feeds:check feeds/roads/nl.jsonc # fetch and parse the feeds of these files live
```

`feeds:lint` fails on any error: a duplicate id, an unknown product, format,
role or decoder, a credential that is undeclared or never used, a shared group
with fewer than two feeds (a group of settings with none), two credentials read
from one environment variable
(`xx-op-flow`'s `events_k` and `xx-op-flow-events`' `k` are both
`XX_OP_FLOW_EVENTS_K`, and a field `k_file` is field `k`'s `_FILE` variant), an
unknown licence, `NOASSERTION` without `terms`, a private URL, a wrong
`$schema`, a `disabled.since` in the future, a catalogue parent without one
usable `endpoints.main.url` or naming a resolver another parent names, or an
approved catalogue child that does not resolve. `feeds:check` fetches and parses each
feed of the given files (every file when none is given); a parse or format error,
or a file that is no region file, fails it, a network or HTTP failure is
reported as a warning, and a feed whose credentials are not set is skipped as
`missing configuration`, naming the variables to set.
