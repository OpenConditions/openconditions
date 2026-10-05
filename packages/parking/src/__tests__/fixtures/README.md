# Parking fixtures

Live captures taken on 2026-10-05 around 03:12 UTC with
`curl -sS -m 60 -A "Mozilla/5.0"` (following redirects where the source
redirects), then trimmed to a few records. Kept records are whole and
unedited unless noted.

| File                   | Source                                                                                                                                                                                                                                   | Records kept                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ghent.geojson`        | https://data.stad.gent/api/explore/v2.1/catalog/datasets/bezetting-parkeergarages-real-time/exports/geojson                                                                                                                              | The Loop; B-Park Dampoort (93 free of 90); Tolhuis; Vrijdagmarkt, **edited** (see below)                                                   |
| `brussels.geojson`     | https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bruxelles_parkings_publics/exports/geojson                                                                                                                                | Albertine Square (15 disabled); Alhambra (0 disabled); Up-site (-999 sentinels); P+R HEYSEL                                                |
| `basel.geojson`        | https://data.bs.ch/api/explore/v2.1/catalog/datasets/100088/exports/geojson                                                                                                                                                              | City (open); Rebgasse (`zu`); Post Basel (no total); Anfos (168 free of 165)                                                               |
| `florence.geojson`     | https://datigis.comune.fi.it/resources/open-data/dati-in-tempo-reale-sui-posti-liberi-nei-parcheggi-di-firenze-posti-liberi/fipark_posti_liberi.geojson                                                                                  | ids 1, 9 (disabled count in a phrase), 4                                                                                                   |
| `vienna.geojson`       | https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:GARAGENOGD&srsName=EPSG:4326&outputFormat=json                                                                                           | 226 (disabled flag), 1268 (P+R), 3553                                                                                                      |
| `salzburg.geojson`     | https://data.stadt-salzburg.at/geodaten/wfs?service=WFS&version=1.1.0&request=GetFeature&srsName=urn:x-ogc:def:crs:EPSG:4326&outputFormat=application/json&typeName=ogdsbg:parkplatz                                                     | 22101 ("490 (79%)"), 22151 ("nicht bekannt"), 22159 (Park & Ride), 22163 (`fallend`), 22158 ("derzeit nicht bekannt")                      |
| `copenhagen.geojson`   | https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=k101:p_hus&outputFormat=json&SRSNAME=EPSG:4326                                                                                                  | ids 106 (no capacity), 8 (P-Kælder), 6 (P-Hus), 110 (type 7, being built)                                                                  |
| `barcelona.json`       | https://opendata-ajuntament.barcelona.cat/data/dataset/a8b29664-ab16-4341-9460-33f60d048d82/resource/3ed73d45-8ea6-4cdf-8984-11a4c4cfc9e8/download                                                                                       | 93291124550; 99327130927 (no street number); the first record with two addresses                                                           |
| `madrid.csv`           | https://datos.madrid.es/dataset/202625-0-aparcamientos-publicos/resource/202625-3-aparcamientos-publicos-csv/download/202625-3-aparcamientos-publicos-csv.csv (found on the dataset page `202625-0-aparcamientos-publicos`, "downloads") | PK 11483771, 13469, 11750494, 13465; raw Latin-1 bytes                                                                                     |
| `bnls.csv`             | https://transport.data.gouv.fr/resources/78899/download (redirects to static.data.gouv.fr `…bnls-v2.csv`)                                                                                                                                | 06027-P-001 (hourly tariffs), 38039-P-001 (`gratuit` 1), 06088-P-013 (many areas); CRLF kept                                               |
| `braunschweig.geojson` | https://www.braunschweig.de/apps/pulp/result/parkhaeuser.geojson                                                                                                                                                                         | Parkhaus Eiermarkt (open), Lange Str. Nord (closed), Magni (no live data); the HTML `description` and `listInformation` fields are dropped |

**Edited record.** On the capture day no Ghent garage was temporarily closed,
so the Vrijdagmarkt record has `temporaryclosed` 1, `isopennow` 0 and
`availablecapacity` -1 (the unknown-count sentinel the city publishes, as in
OpenMapX's `ghent-be-sample.json`). Every other field is as captured.

## Standard formats

Live captures taken on 2026-10-05 between 03:30 and 03:44 UTC with
`curl -sS -m 90` (Overpass with a POST of the query shown), then trimmed to
the records listed. Kept records are whole and unedited; JSON was
re-indented, XML is as published apart from the records taken out.

| File                       | Captured (UTC) | Source                                                                                                    | Records kept                                                                                                                                                                                                     |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parkapi-v3-sites.json`    | 03:31          | https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites?purpose=CAR                               | 50294 (`toll_collect`, 0 free of 90), 19776 Karstadt and 19780 Ettlinger Tor (Stadt Karlsruhe, `CLOSED`), 16590 (P+R, 143 free of 137), 43273 (on-street, no live data)                                          |
| `parkapi-v3-sources.json`  | 03:31          | https://api.mobidata-bw.de/park-api/api/public/v3/sources                                                 | the four sources of the kept sites: `ladenburg_parkraumcheck`, `toll_collect`, `karlsruhe`, `vrs_kirchheim`                                                                                                      |
| `mobidrom-parken-nrw.json` | 03:30          | https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parken-nrw.json                    | `32[Stadthalle]` (live, trend, assignments), `parking-contipark-de-305200` (`temporaryClosed`), `67[P+R Wittlaer Nord]`, `parking-apag-8621` (charging), `parking-contipark-de-107700` (women, disabled, family) |
| `mobidrom-parkride.json`   | 03:30          | https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/gebndelte-daten-parkride-nrw.json  | `park-and-ride-bonn-743457` and `-744694` (double-encoded UTF-8), `park-and-ride-vrr-1201` (latitude and longitude swapped), `park-and-ride-vrr-33461` (live, assignments)                                       |
| `ndw-truck-table.xml`      | 03:32          | https://opendata.ndw.nu/Truckparking_Parking_Table.xml (DATEX II v2)                                      | NL-12_421 (tariff, facilities, rating), NL-12_413                                                                                                                                                                |
| `ndw-truck-status.xml`     | 03:32          | https://opendata.ndw.nu/Truckparking_Parking_Status.xml (DATEX II v3)                                     | NL-12_413 (per-group counts), NL-12_408 (not in the kept table), NL-12_421                                                                                                                                       |
| `cita-static.xml`          | 03:35          | https://www.cita.lu/info_trafic/datex/parking_static.xml (DATEX II v2)                                    | G-MB-B, B-MB-G, C-WC-W                                                                                                                                                                                           |
| `cita-dynamic.xml`         | 03:35          | https://www.cita.lu/info_trafic/datex/parking_dynamic.xml (DATEX II v2)                                   | whole file: G-MB-B and B-MB-G                                                                                                                                                                                    |
| `overpass-parking.json`    | 03:43          | https://overpass-api.de/api/interpreter, `nwr["amenity"="parking"](49.0,8.4,49.05,8.45);out center tags;` | nodes 1725394191 (Karstadt), 282566684, 1336906453 (street side), 25308684 (private); ways 4706466 (`park_ride`), 1013819418 (rooftop)                                                                           |

## Publisher formats

**Live capture.** `sbb-parking.json` was taken on 2026-10-05 at 04:04 UTC with
`curl -sSL` from
https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking/permalink
(302 to the current resource, 302 to a signed Cloudflare R2 URL; 9,152,748
bytes, 2,877 features). Six whole, unedited features are kept, re-indented;
the collection's `type` and `$schema` are as published.

| Feature id                             | Kept for                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `f35490f4-f622-4881-90d0-f4041bdeef78` | Castione-Arbedo: P+R, 24/7, disabled, charging and reservable spaces, estimated occupancy, monthly and yearly tickets |
| `6e189b1d-1424-41f2-92f7-efc2daa960de` | Realp Bahnhof: open 07:15–02:00 every day, two price segments                                                         |
| `ef3699d3-2e29-431d-ad4b-df64551c2caa` | 415 - Rhyhalde: `PARKING`, Monday to Saturday 08:00–18:00                                                             |
| `6935079d-baaa-4f13-a1f5-2ce83941b307` | Dietlikon: tickets with the public transport season ticket discount                                                   |
| `0057697d-defb-4ce6-94fa-6c0a14bb5372` | Herisau: three price segments, one of them free                                                                       |
| `6b868d5e-f242-4543-b904-0473e27f01c0` | Bahnhof Interlaken West: a `BIKE` facility, which is not a car park                                                   |

**Moved from OpenMapX.** These are byte-for-byte copies of OpenMapX's
`integrations/parking/providers/__tests__/fixtures/` at OpenMapX commit
`c320f8326` (added in `88362f508`). They are hand-written samples in each
publisher's documented shape, not live captures: their ids, names and counts
are made up. The tests add live-shaped cases inline where a fixture lacks one
(RDW's `1`/`0` flags, UTMC's `FAULTY`, Open Data Hub's
`2026-05-23 11:40:00.000+0000` times).

| File                               | Publisher shape                                             |
| ---------------------------------- | ----------------------------------------------------------- |
| `db-bahnpark-sample.json`          | DB BahnPark Parking Information API v2 `parking-facilities` |
| `rdw-nl-specs.json`                | RDW SPECIFICATIES PARKEERGEBIED (`b3us-f26s`)               |
| `rdw-nl-garage.json`               | RDW garage areas (`t5pc-eb34`)                              |
| `rdw-nl-pnr.json`                  | RDW P+R areas (`6wzd-evwu`)                                 |
| `rdw-nl-carpool.json`              | RDW carpool areas (`9c54-cmfx`)                             |
| `opendatahub-it-stations.json`     | Open Data Hub `/v2/flat/ParkingStation`                     |
| `opendatahub-it-measurements.json` | Open Data Hub `/v2/flat/ParkingStation/*/latest`            |
| `singapore-static.json`            | data.gov.sg HDB car park information `datastore_search`     |
| `singapore-live.json`              | api.data.gov.sg `transport/carpark-availability`            |
| `utmc-static-sample.json`          | NE Travel Data UTMC `carpark/static`                        |
| `utmc-dynamic-sample.json`         | NE Travel Data UTMC `carpark/dynamic`                       |

**Written for OpenConditions.** `tfnsw-full-list.json` is a `/v1/carpark/full-list`
body: a JSON array of car parks in the per-facility shape of the Car Park API
documentation v2.4 §2.1.5 (the swagger, `carparkswagger_prod_2.yaml`, gives no
example of the body). Tallawong P1 is the documented sample feed with the
occupancy strings of OpenMapX's `nsw-au-detail-26.json` (`total` "75");
Ashfield is OpenMapX's `nsw-au-detail-486.json` unchanged; Penrith
(multi-level) is made up, with more vehicles counted than spots and a July
`MessageDate` (Sydney standard time).
