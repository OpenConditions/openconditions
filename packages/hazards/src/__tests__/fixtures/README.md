# Hazards fixtures

## CAP fit captures

Copied unchanged from `packages/model-registry/src/__tests__/fixtures/alerts/`, where the alerts fit
check captured them:

- `dwd-thunderstorm.xml`: a DWD CAP warning per district (`DEU`), from
  https://opendata.dwd.de/weather/alerts/cap/ (DISTRICT_DWD_STAT), captured 2026-09-29.
- `dwd-coastal-gusts-mul.xml`: a DWD CAP update in all eight languages (`MUL`), with
  `EXCLUDE_POLYGON` islands, from https://opendata.dwd.de/weather/alerts/cap/ (DISTRICT_DWD_STAT),
  captured 2026-09-29.
- `eccc-storm-surge.xml`, `eccc-storm-surge-ended.xml`, `eccc-fog.xml`: ECCC CAP-CP messages from the
  MSC Datamart, https://dd.weather.gc.ca/today/alerts/cap/, captured 2026-09-30.

## DWD status zip

- `dwd-stat-mul.zip`: three entries of DWD's COMMUNEUNION status zip in every language, assembled
  from two captures of 2026-10-08 (the entries are unchanged; the zip is constructed, because a
  status zip never holds a message and the update that replaced it):
  - `…1791429420000.4d343c7a…MUL.xml` (a coastal gale warning, coast cells `501000006`,
    `501000007`) from
    https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_DWD_STAT/Z_CAP_C_EDZW_20261008085710_PVW_STATUS_PREMIUMDWD_COMMUNEUNION_MUL.zip,
    captured 2026-10-08;
  - `…1791450480000.293dd8a7…MUL.xml` (its update, which references it) and
    `…1791478140000.59b4e26a…MUL.xml` (a gusts warning with `EXCLUDE_POLYGON` holes) from
    https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_DWD_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMDWD_COMMUNEUNION_MUL.zip,
    captured 2026-10-08 21:56 UTC.
- `dwd-coast-strong-wind-mul.xml`: the entry `…1791554520000.6f657cc9…MUL.xml` of the LATEST
  COMMUNEUNION status zip, unchanged, captured 2026-10-09 18:54 UTC: a strong-wind update in every
  language for coast cells `501000005`, `501000001` and `501000002`, with no polygon.

## DWD warning areas

From DWD's GeoServer WFS (`https://maps.dwd.de/geoserver/dwd/ows`, `outputFormat=application/json`),
captured 2026-10-09, properties unchanged, coordinates thinned to about 40 vertices per ring and
rounded to four decimals:

- `dwd-areas-coast.json`: `dwd:Warngebiete_Kueste`, cells `501000005` and `501000001` of eight.
- `dwd-areas-lakes.json`: `dwd:Warngebiete_Binnenseen`, cell `208438000` (Bodensee - Mitte) of 23.

## ECCC Datamart walk (`eccc-datamart/`)

Apache index pages, stored as `.txt` so the linter leaves the served markup alone, copied from
`packages/ingest-framework/src/__tests__/fixtures/eccc-datamart/` (captured 2026-10-08):

- `day.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/ (offices trimmed to
  `CWTO/`)
- `office.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/ (hours trimmed to
  `18/`, `19/`)
- `hour-18.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/18/ (files
  trimmed to `T_WHCN13_C_CWTO_202610081811_2451493062.cap`)
- `hour-19.txt`: https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/19/ (files
  trimmed to two)

The three CAP files those listings name, one warning's chain (each message updates the ones before
it), captured 2026-10-08 21:57 UTC:

- `T_WHCN13_C_CWTO_202610081811_2451493062.cap`:
  https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/18/T_WHCN13_C_CWTO_202610081811_2451493062.cap
- `T_WHCN13_C_CWTO_202610081936_2688257323.cap`:
  https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/19/T_WHCN13_C_CWTO_202610081936_2688257323.cap
- `T_WHCN13_C_CWTO_202610081959_1129882422.cap`:
  https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/CWTO/19/T_WHCN13_C_CWTO_202610081959_1129882422.cap

The tests construct the zero-file day (the day listing without its office) and the messages
changed in one header field each (`status`, `msgType`, `sent`); those cases are built in the test,
not captured.

## NWS

All captured 2026-10-08, keyless, with the user agent `OpenConditions-NwsAlerts/1.0`.

- `nws-alerts-active.json`: six features of https://api.weather.gov/alerts/active (the unfiltered
  snapshot of 21:04 UTC, 592 features; the feed asks `?status=actual`, so the `Test` one is a
  stray), unchanged: a Flash Flood Warning (polygon, VTEC), a Flood Warning `Update` (polygon,
  `references` and `expiredReferences`), a zone-only Flood Watch (nine forecast zones), a Small
  Craft Advisory for marine zone `PKZ662`, an Air Quality Alert (`AQA`, one county zone), and a
  `Test Message` (`status` `Test`).
- `nws-zone-forecast-FLZ019.json`: https://api.weather.gov/zones/forecast/FLZ019, coordinates thinned
  to about 40 vertices and rounded to four decimals.
- `nws-zone-county-FLC079.json`: https://api.weather.gov/zones/county/FLC079, thinned the same way.
- `nws-zone-forecast-PKZ662.json`: https://api.weather.gov/zones/forecast/PKZ662, thinned the same way.
- `nws-zone-fire-AKZ801-404.json`: https://api.weather.gov/zones/fire/AKZ801, the 404 problem
  document, unchanged.

The capture holds no alert whose zones mix a forecast and a county zone, and no `Update` beside the
message it replaces (the active view drops the replaced one). The tests construct both from the
captured records: the watch's `affectedZones` cut to `forecast/FLZ019` and `county/FLC079`, and the
Update's predecessor as a copy of it that carries the referenced identifier.

## MeteoAlarm

Captured 2026-10-08/09, keyless, from `https://feeds.meteoalarm.org/api/v1/warnings/feeds-<country>`,
warnings kept whole and unchanged, the list trimmed:

- `meteoalarm-austria.json`: `feeds-austria`, two EMMA_ID warnings that are `Update`s with
  `references` (the messages they replace had expired from the feed).
- `meteoalarm-switzerland.json`: `feeds-switzerland`, one warning with an inline polygon, in five
  languages.
- `meteoalarm-france.json`: `feeds-france`, two warnings with NUTS3 areas.
- `meteoalarm-ireland.json`: `feeds-ireland`, one warning with FIPS 10-4 regions `EI01`…
- `meteoalarm-czechia.json`: `feeds-czechia`, two warnings with CISORP and EMMA_ID areas. Its event
  code was `SIVS` on the day; the WMO `OET` list is carried by Norway's warning in
  `meteoalarm-warnings.json`.
- `meteoalarm-geocodes.json`: eleven features (`AT801`…`AT804`, `AT413`, `CZ03104`, `CZ04201`,
  `CZ04106`, `IE006`, `BE001`, `FR006`) of
  https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Geocodes_2026_07_31.json,
  coordinates thinned to about 40 vertices per ring and rounded to four decimals (`FR006` has 41
  and is only rounded).
- `meteoalarm-warnings.json`: the alerts fit capture (France, Norway, Spain), copied from
  `packages/model-registry/src/__tests__/fixtures/alerts/`, content unchanged (reformatted).

## Fires and smoke

Fit captures, copied unchanged from `packages/model-registry/src/__tests__/fixtures/hazards/`,
captured 2026-10-01:

- `firms-viirs-snpp.csv`: four rows (one `low` confidence) of
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv.
- `firms-modis.csv`: three rows (one with confidence 20) of
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv.
- `nifc-perimeters.geojson`: three features (Aspen Acres and Tartar, wildfires; Ranger Academy RX
  Burn 5, a prescribed burn) of the WFIGS_Interagency_Perimeters_Current layer,
  https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query.
- `effis-burnt-areas.geojson`: two features (Portugal, Italy) of
  https://maps.effis.emergency.copernicus.eu/effis?service=WFS&version=1.1.0&request=GetFeature&typename=ms:modis.ba.poly.week&outputformat=geojson.
- `hms-smoke.geojson`: three features, one per density, of the NOAA_Satellite_Smoke_Detection_(v1)
  layer,
  https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query.

Captured 2026-10-09, keyless:

- `firms-viirs-n21.csv`: the header and the first four rows of
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv
  (satellite `N21`, all `nominal`, night).
- `firms-viirs-n20.csv`: the header and the first three rows of
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv
  (satellite `N20`).
- `firms-viirs-header-only.csv`: the header line of the J2 file alone; constructed (the global file
  is never empty, so no live capture of this case exists).
- `nifc-incidents.geojson`: three features of the WFIGS_Incident_Locations_Current layer,
  https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query
  (`where` on the IRWIN ids, `outSR=4326`, `f=geojson`, the feed's incident fields), unchanged:
  NEWMAN DR (a wildfire with no perimeter), Aspen Acres (the incident of the perimeter above) and
  ROWE CREEK COMPLEX (`CX`). The points of Tartar and Ranger Academy RX Burn 5 had fallen off the
  layer by the capture day, so those two fires are perimeter-only records in the tests.
- `arcgis-error.json`: the layer's answer to a query on a field it lacks, HTTP 200 with an `error`
  document, same URL with `where=BOGUS_FIELD = 1` (reformatted).
- `effis-el-ks-zero.geojson`: three features of the weekly layer URL above, unchanged except that
  the feature list is trimmed: 820007 (`EL`, Andros), 809756 (`KS`, Kosovo, `N.A.` province and
  commune) and 819925 (Italy, `AREA_HA` `"0"`).
- `effis-exception-report.xml`: constructed. EFFIS's gateway answers a bad request with HTTP 502
  and an unreadable body, so no live ExceptionReport could be captured; this is the OGC
  ExceptionReport a MapServer answers for an unknown type name, which a gateway may pass as 200.

## Earthquakes, natural events, disasters

All captured 2026-10-09 (the USGS and GDACS files are rewritten every minute to ten minutes, so a
re-capture differs in the newest records).

- `usgs-all-day.geojson`: four features of
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson, unchanged:
  us6000u0xi (M 6.3 Vanuatu, PAGER green, felt, MMI, two `ids`), the quarry blast ci41345175, the
  explosion uw714118181 (negative depth) and aka2026typggm (its `ids` hold us6000u10t: the
  preferred id changed).
- `usgs-all-month.geojson`: five features of `.../summary/all_month.geojson`, unchanged:
  us6000u0xi, us6000ty43 (`tsunami` 1), uu80158811 (a negative-depth earthquake), ci41345175 and
  us6000u0x4.
- `usgs-constructed.geojson`: constructed from the two captures above, because no live feed holds
  these cases today: us6000u10t (a copy of aka2026typggm under the id its `ids` also names, an
  hour older and `automatic`: two features sharing an `ids` entry) and uu80158811 with `mag` null
  (USGS publishes a null magnitude for an event not yet magnitude-rated; none was listed).
- `eonet-open.json`: four events of
  https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes,seaLakeIce,floods,landslides,dustHaze,drought
  unchanged except for the geometry list of Iceberg D32 (EONET_6288), cut from 66 dated points to
  the first two and the last two: Nevados del Chillan (a volcano), Iceberg D33D and D32, and
  Fuego (EONET_980, which names a GDACS source and a dated geometry from 2002). No open
  GDACS-sourced flood was listed that day; Fuego is the live open event with a GDACS source.
- `eonet-closed.json`: one event of the same URL with `status=closed&days=30`: the flood
  EONET_25047 (GDACS source), its polygon cut to nine vertices and closed.
- `eonet-closed-volcano.json`: Akan Volcano (EONET_19906), a closed event without a GDACS source,
  from the same URL with `status=closed&days=1500` (the last 30 days hold only GDACS floods).
- `gdacs-rss.xml`: eleven items of https://www.gdacs.org/xml/rss.xml, unchanged: tropical cyclones
  ISAIAS-26 (hurricane text), SIMON-26 (tropical storm text) and KOGUMA-26 (typhoon text), floods
  1104169 and 1104203 (current) and 1104213 (`iscurrent` false), the volcano Taal, droughts
  Europe-2026 (current) and East Africa, Central Sahel-2026 (ended), one earthquake and one
  wildfire.
- `gdacs-cap.xml`: five alerts of https://www.gdacs.org/xml/gdacs_cap.xml, unchanged except that
  each polygon is thinned to at most 19 vertices and closed: the TC alerts of ISAIAS-26 (episode 9) and SIMON-26 (episode 6), the flood 1104203 (two areas), the flood 1104213 and one
  earthquake.
