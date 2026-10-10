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
  cameras/
    fi.jsonc
    us.jsonc
    global.jsonc
    …
  hazards/
    ca.jsonc
    de.jsonc
    eu.jsonc
    us.jsonc
    global.jsonc
  schema/                  generated JSON Schemas (do not edit)
    roads.schema.json
    fuel.schema.json
    parking.schema.json
    charging.schema.json
    cameras.schema.json
    hazards.schema.json
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
`openlrResolver`, `laneNumbering`, `timezone`, in `packages/roads/src/feed-schema.ts`;
parking: `layout` and `parking`, in `packages/parking/src/feed-schema.ts`;
charging: `layout` and `charging`, in `packages/charging/src/feed-schema.ts`;
cameras: `layout` and `cameras`, in `packages/cameras/src/feed-schema.ts`; see
[Generic layouts](#generic-layouts)) or none (fuel, hazards).

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

A road feed's `timezone` is the IANA zone its publisher writes times without
an offset in (`2026-07-14T09:34:00`, `2026/02/09 06:30`, `2026-10-11 03:53:30`).
Without it such a time is read as UTC, whatever zone the instance runs in, so
set it for any publisher that writes local time: left out, its records start,
end and change hours off.

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

The cameras product is:

| product   | what                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| `cameras` | traffic, weather and landscape cameras, their views, and each view's latest image |

Every camera format is a `features` format, whose records are the model's
`camera` features with their `camera_view` components and a `camera.image`
reading per view (they stay in the model's `roads` domain, so a read asks for
`kind=camera`). A plain GeoJSON, JSON or CSV table is written in the generic
layout of that name with a `layout` block and a `cameras` mapping. The
standards and publishers' APIs have a format each: `datex2` (a DATEX II v3
device publication), `ibi511` (the IBI 511 platform's camera list),
`digitraffic`, `trafikverket`, `tdx`, `hk-td`, `tfl`, `nps`, `tripcheck`,
`windy` (on demand) and `overpass` (OpenStreetMap, on demand). The formats are
in `packages/cameras/src/domain.ts`.

Every camera feed whose records carry image URLs declares, in its `cameras`
block, the hosts its stills are fetched from (`imageHosts`): an exact host
(`weathercam.digitraffic.fi`), every subdomain of a domain (`*.thb.gov.tw`), or
a host and a path prefix ending in `/`
(`s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/`). A still on any other host
is dropped, and `GET /sources` serves the list, so a consumer's image proxy
admits exactly these hosts. A feed whose stills sit on hosts no one can list
(`osm-cameras`) declares none: its image URLs are kept for a consumer to link,
never to proxy. `imageRedistribution` in the same block says what the images'
licence allows (`allowed`, `link_only`, `unknown`) where the feed's terms
differ from its format's default (`ca-on-511-cameras`).

The hazards products are:

| product  | what                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| `alerts` | warnings authorities issue as CAP messages, in every language they carry      |
| `fires`  | wildfires: perimeters and incidents, burnt areas, and satellite fire pixels   |
| `smoke`  | smoke plumes by density                                                       |
| `quakes` | earthquakes                                                                   |
| `events` | other natural events: tropical cyclones, floods, volcanoes, droughts, sea ice |

Every hazards format reads its publisher's own shape, so a hazards feed has no
mapping block. Every format but `firms` is a `situations` format whose poll is
the publisher's complete current set (`snapshot`), so a record missing from it
is withdrawn, and a poll with no record publishes zero: the CAP formats `cap`
(CAP 1.2 XML, one message per payload), `nws` (the NWS alerts API's
GeoJSON-LD) and `meteoalarm` (MeteoAlarm's CAP as JSON), and `wfigs`, `effis`,
`hms`, `usgs`, `eonet` and `gdacs`. One poll sees every current message of a
CAP feed, so a message that another message of the poll updates or cancels is
left out and its successor names it. `firms` is a `measurements` format: each
fire pixel is one `fire.frp` reading at its position, written once and swept
72 hours after the satellite saw it. The formats are in
`packages/hazards/src/domain.ts`.

The hazards roles:

- `cap` reads `alerts`, the CAP files: a zip's entries (`de-dwd-alerts`, with
  `unzip`) or the files a walk over the `index` listings finds
  (`ca-eccc-alerts`, whose Datamart files each message under its day, office
  and hour). The optional `areas` role is GeoJSON layers keyed by
  `WARNCELLID` (DWD's coast and lake warning areas): an area with no polygon
  of its own takes the union of its warn cells' shapes.
- `nws` reads `alerts` and `zones`, an `each` endpoint over the alerts'
  `affectedZones` that fetches each zone's shape once and keeps it for 30
  days. A zone-only alert is drawn as the union of its zones' shapes; a zone
  that answers 404 adds nothing, and an alert with no zone shape keeps its
  geocodes and no geometry.
- `meteoalarm` reads `alerts`, one URL per country, and `geocodes`,
  MeteoAlarm's file of the regions it names by EMMA id. NUTS, Irish FIPS 10-4,
  Czech CISORP and DWD warn-cell codes reach those regions through a copy of
  MeteoAlarm's alias file that the hazards package carries
  (`scripts/gen-meteoalarm-aliases.ts` refreshes it). An area named by EMMA id
  takes those shapes alone; an area neither resolves keeps its codes and no
  geometry.
- `wfigs` reads `perimeters` (optional) and `incidents`: a fire in both layers
  is one record, named by its IRWIN id.
- `usgs` reads `recent` (the last day) and `window` (the last month): an
  earthquake inside the month that both leave out has been deleted.
- `eonet` reads `open` and `closed` (optional, the events closed lately);
  `gdacs` reads `events` and `areas` (optional, the CAP areas of the current
  episodes).
- `firms`, `effis` and `hms` read `main`.

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
`follow`, `each`, `unzip`, `impersonate`, `expand` (see credentials) and `fanout`, for an
endpoint of several URLs (`urls` or `expand`): `"all"`, the default, needs every
URL to answer, so one failure fails the poll; with `"tolerant"` a failing URL
does not fail the poll. A bulk feed's tolerant `urls` role keeps each URL's
latest answer: a URL that fails is stood in for by its answer while that is no
older than the endpoint's `maxPayloadAgeSec` (at any age without it); past
that the URL contributes nothing, its records are withdrawn, and the others
publish as a complete set (MeteoAlarm's countries are independent feeds). When
every URL fails, each still stands in by its own answer and age, never the
role's held payload. A tolerant `expand` role's set is incomplete, so a bulk feed keeps its last
complete publication (or the role's held payload). Either way the failing URLs
are asked again at the next poll, and an on-demand cell is written without
withdrawing anything. `"tolerant"` sends no conditional requests.

A URL may name the poll's UTC date as `{utcDate}` (`YYYYMMDD`) and an earlier
day as `{utcDate-1}` to `{utcDate-7}`, for a publisher that files its data
under the day: `https://dd.weather.gc.ca/{utcDate}/WXO-DD/alerts/cap/{utcDate}/`.
The date is the instant the poll started, in UTC, filled in the same pass as
credentials, so a credential's value is never read for one. Any other
`{utcDate…}` is a schema error.

`unzip` is for an endpoint that answers with a zip archive:
`{ "entries": "\\.xml$", "maxEntries": 10000 }`, both optional. The role's
payloads are the archive's entries whose name matches `entries` (every entry
without it), in name order; directories are skipped. Stored and deflated entries
are read, each checked against its CRC-32; a ZIP64 archive, an encrypted entry or
any other compression method fails the fetch, and so does an archive that lists
more than `maxEntries` entries (10,000 by default) or whose entries together
inflate past the feed byte cap. The bound is per archive, not per role: each
archive of a role with several URLs may inflate up to the cap. The archive as
fetched is the payload's digest and what the raw archive keeps. `unzip` cannot
be combined with `each` or `pagination`.

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

`each` is for a detail endpoint that is fetched once per item found in another
role's payload. `role` is a data role of the same feed (not reference data, not
itself `each`). The items are found in one of two ways.

- **Listed in JSON:** `{ "role": "sites", "records": "features", "field": "id" }`.
  `records` is the dotted path to the list in that role's JSON payload and
  `field` the path of the item within each record (numeric segments index
  arrays, as in `follow.path`): a string, a number or a list of strings. A
  record without one is skipped. `pattern`, a regular expression with a group,
  keeps only the values it matches and takes its first group as the item:
  `"^https://api\\.weather\\.gov/zones/((?:forecast|county)/[A-Z0-9]+)$"` turns
  a zone URL into `forecast/WYZ001`. The endpoint's `url` must contain `{item}`,
  which is filled with the item, each `/`-separated segment URL-encoded and the
  slashes kept (`forecast/WYZ001`, `C%202`). An item with an empty, `.` or `..`
  segment, or with `?`, `#` or `\`, is refused (logged and counted, never
  fetched). `keepSec` keeps each item's payload between polls: an item fetched
  less than `keepSec` seconds ago is not asked again, and its kept payload
  stands in.
- **Walked through directory listings:**
  `{ "role": "index", "links": ["href=\"([A-Z]{4}/)\"", "href=\"([^\"]+\\.cap)\""] }`,
  with `url` exactly `{item}`. The source role's payloads are listings (HTML is
  accepted there). Each pattern is one level: its first group is a link's href,
  resolved against the listing's URL, and its optional second group the entry's
  version (such as its modification time). A link is followed only when it lies
  below the listing's directory on the same host, never to another host, the
  parent or a sibling. Each level's links are fetched and read by the next
  pattern; the last level's items are the role's payloads, in the order the
  listings name them. A listing with a version is listed again when its version
  changes and once more at the next poll, and skipped only once the same version
  was seen twice (a listing's minute-resolution time can hide a file written in
  the minute it was read); one without a version at every poll. A last-level
  item is fetched again only when its version changes, and without one never
  while it is listed. A listing that matches no link is a failed listing, not an
  empty level: its kept copy stands in, and without one the walk is partial (so
  the last publication stands) or, without `fanout: "tolerant"`, the role fails.

An item that appears twice is fetched once. The payloads arrive in the order of
the items. Kept items (with `keepSec` or a walk) live in the ingest process,
like held payloads, and leave once the source no longer names them; a kept copy
also stands in for an item whose request failed. The endpoint cannot be
combined with `urls`, `expand`, `follow`, `pagination` or `unzip`. The source role
is fetched first in the same poll; when it was not due or failed, the payload it
last delivered stands in, and with none the role fails. The requests carry the
feed's `auth` and the endpoint's `headers`, share the feed's
`requestLimits.perMinute` with its other requests, and send no conditional
requests. With `fanout: "tolerant"` a failing item costs only that item's
payload (or its kept copy stands in): the items that answered are the role's
payload for the poll, which goes on and publishes, and the role is not asked
again before its cadence; the shortfall is recorded on the poll. Otherwise the
first failure stops the requests and fails the poll.

A role that fails while an earlier payload of it is held is parsed with that
payload (see below). `maxPayloadAgeSec` on the endpoint bounds that: a held
payload fetched longer ago than this is never parsed, the role counts as failed
with nothing held, and a required role fails the poll, so the last publication
stands. It is for a publisher whose terms allow its data to be shown only while
recent; a role without it (a reference file refreshed monthly) keeps its held
copy at any age.

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

A camera format reads its cameras from `main`, except two. `digitraffic` reads
the station list as `sites` (required), each station's details as `details`
(an `each` endpoint over the list's ids) and every preset's latest image time
as `status`, which is parsed on its own between the daily lists. `hk-td` reads
the English list as `main` and the Traditional Chinese one, for the names, as
`names`.

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
`au-nsw-tfnsw` (the Open Data Hub token of the NSW hazards, car parks and
cameras), `tw-tdx` (the TDX client pair of the charging and camera feeds),
`ca-on-511` (Ontario 511's developer key), `us-oh-ohgo`, `hr-hc`, …; a regional
issuer's group is `<region>-<issuer>`. A group serves at least two feeds, which
may be of different domains; a credential one feed uses stays on that feed.

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
`reviewedAt`, `note`, `notice`, and any of `redistribution`,
`derivedRedistribution`, `commercialUse`, `attributionRequired`, `retention`.
A key set in `terms` (even to `null`) overrides the licence; an absent key
defers to it. `notice` is a text the publisher requires to accompany any
display of its data, written verbatim (MeteoAlarm's disclaimer); `GET
/sources` serves it.

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
- A read's `coverage` block lists each on-demand source it touched, with the
  reason one fell short (`too_many_cells`, `limited`, `failed`, `deadline` or
  `missing_configuration`). `partial` is set, and the answer is not cached,
  only when a source that could answer fell short: a source missing its
  credentials is listed with `missing_configuration` but leaves the read
  complete, since waiting or zooming in never helps it.
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

A camera feed in a generic layout is read through `layout` and the whole
`cameras` mapping, both required; a format with its own parser reads neither
beyond `imageHosts` and `imageRedistribution`, and `feeds:lint` refuses any
other mapping field there. A JSON record keeps its geometry at `geometryPath`
(`geometry`, for a GeoJSON collection whose id lies outside `properties`).
Records sharing a camera id are one camera and each record one of its views:

```jsonc
"format": "geojson",
"layout": {},
"cameras": {
  "imageHosts": ["kamera.atlas.vegvesen.no"],
  "groupBy": { "field": "cameraId", "pattern": "^([^_]+)_" },
  "viewKey": "cameraId",
  "name": "description",
  "lang": "no",
  "type": "traffic",
  "imageUrl": "stillImageUrl",
  "status": { "field": "status.stillImageAvailability", "map": { "videoOrImagesAvailable": "online" } },
  "imageRedistribution": "allowed",
},
```

| member                        | what                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`, `groupBy`               | exactly one: the camera id (a list of fields joins into one), or the field all of a camera's per-view records share |
| `viewKey`                     | the view's key within its camera; `0` by default                                                                    |
| `name`, `lang`, `description` | the camera's name and description; the language of the texts (required)                                             |
| `type`                        | `traffic`, `weather`, `landscape`, `city`, `beach` or `other`, or a value map with a `default` (required)           |
| `road`                        | the road the camera stands on, by its number                                                                        |
| `viewName`, `direction`       | the view's name; a compass word (value map) for where it looks or the road's travel direction                       |
| `bearing`                     | where the view looks in degrees: only a true camera bearing                                                         |
| `imageUrl`, `thumbnailUrl`    | the still and its thumbnail, which need the feed's `imageHosts`                                                     |
| `streamUrl`, `streamType`     | a video stream (`hls`, `mjpeg`, `mp4`, …), played by the consumer's browser and never proxied                       |
| `status`                      | value map onto `online`, `offline`, `stale`, `unknown`; a value it does not map is `unknown`                        |
| `refreshSec`, `imageAt`       | how often the still renews (seconds, or a field in `s` or `min`); when it was taken (`iso`, `epoch-s`, `epoch-ms`)  |
| `detailUrl`                   | the publisher's page of the camera                                                                                  |
| `imageRedistribution`         | what the images' licence allows: `allowed`, `link_only` or `unknown` (required)                                     |

A camera's own fields come from the record of its first view key, so the
publisher's row order changes nothing. Nothing is guessed from free text: a
caption saying where a view looks stays its name, never a bearing.

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

Camera sources considered and left out, reviewed on 2026-10-08.

| source                                              | reason                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FL511 (Florida DOT)                                 | "For personal purposes only", and re-use needs FDOT's written consent. There is no key programme.                                                                                                                                                                       |
| 511PA (PennDOT)                                     | The terms forbid republishing or storing the material "in any public or private retrieval system". There is no key programme.                                                                                                                                           |
| 511SC (SCDOT)                                       | It left the IBI platform and has no API, and the terms forbid publishing any content without written permission.                                                                                                                                                        |
| Mass511 (MassDOT)                                   | It left the IBI platform. The only camera list is the website's internal API, scraping is forbidden, and the images are TrafficLand streams.                                                                                                                            |
| 511NY (NYSDOT) cameras                              | The camera inventory is granted on request under the Developer Access Agreement of 2026-09-18, and its format is sent only after approval. The old API is gone. The `us-ny-511` credential guide says how to request it together with the events and winter road feeds. |
| NPS live stills                                     | They exist only on each camera's HTML page; the API carries stock photos. `us-nps-cameras` links each camera to its page.                                                                                                                                               |
| Windy `all-webcams.json` export                     | Paid tier, with the same redistribution terms. `windy-cameras` reads per cell.                                                                                                                                                                                          |
| TDX `CCTV/City/{City}`                              | The streams are web player pages with no stills.                                                                                                                                                                                                                        |
| NSW `data.livetraffic.com/cameras/traffic-cam.json` | A keyless copy, but not a documented API. The keyed API is taken (`au-nsw-livetraffic-cameras`).                                                                                                                                                                        |
| NFB `CCTV.xml` (`tisvcloud.freeway.gov.tw`)         | Unreachable from Europe. TDX carries the same freeway list (`tw-tdx-cameras`).                                                                                                                                                                                          |

Hazard sources considered and left out, reviewed on 2026-10-08.

| source                                                                            | reason                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| FIRMS Suomi NPP VIIRS files                                                       | NASA ends their delivery on 2026-11-02; NOAA-20 and NOAA-21 replace them (`nasa-firms-viirs-fires`).                                |
| FIRMS Landsat                                                                     | US and Canada only, with no fire radiative power or brightness, so no `fire.frp` reading.                                           |
| FIRMS Area API                                                                    | Keyed, with the key in the URL path; the keyless global files carry the same near-real-time rows.                                   |
| EFFIS active fire layers (`viirs.hs`, `modis.hs`, `all.hs`)                       | EFFIS's copy of the FIRMS pixels, which are taken first-hand.                                                                       |
| NOAA HMS fire points                                                              | Mostly GOES detections and the FIRMS VIIRS pixels already taken.                                                                    |
| EONET wildfires, earthquakes and severe storms, and EONET events taken from GDACS | First-hand sources are taken: NIFC, EFFIS and FIRMS for fires, USGS for earthquakes, GDACS for cyclones and its own events.         |
| GDACS earthquakes and wildfires                                                   | USGS, NIFC, EFFIS and FIRMS are taken first-hand.                                                                                   |
| MeteoAlarm EDR, MQTT and Metadata API (`api.meteoalarm.org`)                      | Token only, for MeteoAlarm's members and redistributors; the public feeds carry the same CAP.                                       |
| MeteoAlarm legacy RSS                                                             | Sunset on 2026-01-14.                                                                                                               |
| ECCC OGC API `weather-alerts` (`api.weather.gc.ca`)                               | Not CAP: no identifier, references, urgency, certainty or event codes. The CAP Datamart carries the same alerts (`ca-eccc-alerts`). |
| DWD WFS `Warnungen_*` (`maps.dwd.de`)                                             | German only, no references, one layer per area type; the CAP status zip carries all of it in eight languages (`de-dwd-alerts`).     |
| NWS Atom (`/alerts/active.atom`)                                                  | No references or event codes; the GeoJSON is complete (`us-nws-alerts`).                                                            |

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
