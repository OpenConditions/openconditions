# Charging fixtures

## Layout feeds

Live captures taken on 2026-10-06 between 02:11 and 02:14 UTC with
`curl -sS -m 60 -A "Mozilla/5.0"` (following redirects where the source
redirects), then trimmed to the records listed. Kept records are whole and
unedited; JSON was re-indented, CSV rows are as published with line endings
written as LF (the CSV reader takes CRLF and LF alike).

| File              | Source and licence                                                                                                                                                                                                                                 | Records kept                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `be-vlg-mow.json` | https://geoserver.gis.cloud.mow.vlaanderen.be/geoserver/beleid/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=laadpunten_public&outputFormat=application/json&srsName=EPSG:4326&count=300&startIndex=0, Modellicentie Gratis Hergebruik | location `a4d397a0…` (two `semi-publiek` rows, one EVSE each); `ff248c18…` (`ac_1_phase`, an `evs_` EVSE suffix); `8c7d64a2…` rows `*1` and `*2` (DC, CCS); the collection header                         |
| `be-wal-spw.csv`  | https://geoservices.wallonie.be/geotraitement/spwdatadownload/results/c731a282-e378-49f3-8ab6-f9a90e7a5683/BORNES_RECHARGE_XY_31370.csv, CC BY 4.0                                                                                                 | `89b3a26e…` Namur (two connectors, the reprojection control point); `e1d3e1e0…` (150 kW); `fcd0395c…` (restrictions); `f9ac76b8…` (no operator, a garage); OBJECTID 12412 (no `EMPLACEMENT_ID`); BOM kept |
| `hk-epd.geojson`  | https://portal.csdi.gov.hk/csdi-webpage/file-api?dataset_id=epd_rcd_1631080339740_69941&format=geojson&layer_name=geotagging, CSDI Portal Terms and Conditions of Use                                                                              | Yuen Chau Kok Complex (BS 1363 and Type 2); ELEMENTS Carpark (every DC standard); Shun Lee (Shopping Centre) Car Park (one Type 2)                                                                        |
| `au-nsw.csv`      | https://opendata.transport.nsw.gov.au/data/dataset/be1c4de4-4517-4bd0-8a09-2965ddfc7179/resource/7bbb6461-e52d-4fe7-ace4-a15c30198de0/download, CC BY 4.0                                                                                          | OBJECTID 1 (`Upcoming`, `2x350kW & 2x175kW`); 16 (DC 50 kW); 324, 1099 and 1160 (three operators at one point, `Tesla Motors ` with its trailing space); 1006 (`AC` rating); 1070 (`22` without a unit)   |
| `au-vic.geojson`  | https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:dcav_site&outputFormat=application/json&srsName=EPSG:4326, CC BY 4.0                                                      | `dcav_site.1` (`1 x CCS2, 1 x CHAdeMO`); `.14` (empty plug list); `.22` (every property null); `.137` (`Type 2` alone); `.144` (`CCS2` alone); `.33` (`… and …`); the collection header                   |

## Standard formats

### Shared with the decoders

The OCPI, OCPDB, NDW, Lithuanian and Digitraffic captures, and the DGT,
Slovenian and Lithuanian DATEX II ones, are read where the decoder packages
keep them (`packages/ocpi/src/__tests__/fixtures/`,
`packages/datex2/src/__tests__/fixtures/`; the test helpers `ocpiFixture` and
`datexFixture`); their sources, licences, capture dates and edits are in
those packages' READMEs.

### Live captures

Taken on 2026-10-06, trimmed to the records listed (kept records whole and
unedited, the envelope kept), and re-indented by the repository's formatter.

- `oicp-data.json` and `oicp-status.json`: captured at 02:45:56 UTC with
  `curl -sS -m 120 -A "Mozilla/5.0" --compressed` from
  https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json
  and
  https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/status/oicp/ch.bfe.ladestellen-elektromobilitaet.json.
  Licence: opendata.swiss terms of use, "terms_by_ask" (BFE / ich-tanke-strom.ch).
  - Move (`CH*CCC`, facilities written as strings, `"22.0"`): the five EVSEs
    `CH*CCI*E22075` to `E22079` at one spot of the CERN esplanade (no pool, one
    position), and `CH*CCI*E20277` (`Occupied`), `CH*CCI*E22459`
    (`OutOfService`), `CH*CCI*E22896` (`Available`); the five CERN EVSEs are
    `Unknown`.
  - M-Charge (`CH*MIG`): the pool `CH*MIG*P*321`, four DC EVSEs.
  - Fastned (`CH*FASTNED`): `CHFASE410051` (`EvseNotFound`).
  - The status file holds the status record of each of these EVSEs. No live
    EVSE was `Reserved` (Available 11,512, Unknown 1,518, OutOfService 1,226,
    Occupied 988, EvseNotFound 4); the test writes that status itself.
- `overpass-charging.json`: captured at 02:46:45 UTC with
  `curl -sS -m 90 -A "OpenConditions-OsmCharging/1.0" -X POST https://overpass-api.de/api/interpreter --data-urlencode 'data=[out:json][timeout:25];nwr["amenity"="charging_station"](48.98,8.35,49.05,8.45);out center tags;'`
  (the `Mozilla/5.0` agent was answered 406). Licence: ODbL 1.0, © OpenStreetMap
  contributors. 14 of the 127 elements: the ways 1225082333 (Tesla
  Supercharger), 1482920894, 1225078992 (`socket:chademo=0`,
  `150kW;300kW`) and 1151646807; the relation 19682362 (no sockets); the nodes
  3194635651 (`ref:EU:EVSE` list), 3194635652 (bicycles and cars),
  5549850413 (an e-bike charger, `motorcar=no`), 10825071354 (`bicycle=yes`,
  Schuko only), 4793460914 (`fee=no`, `authentication:none`), 11553945999
  (`socket:type2_cable`, bare outputs), 8715570050 (`access=customers`,
  socket voltage and current), 13743952752 and 10237871211. No element of
  this area, of Germany or of Europe (Overpass searches on the same day)
  writes a `socket:type2:output` in watts; the `11000 W` case is an element
  the test writes itself.

### Publisher formats

- `bnetza.csv`: captured at 05:39 UTC on 2026-10-06 with
  `curl -sS -m 300 -A "Mozilla/5.0" -L` from
  https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-09-01.csv
  (the link the download page carried that day; 55,559,083 bytes), CC BY 4.0
  (Bundesnetzagentur.de). The BOM, the ten preamble lines, the header row and
  CRLF line ends are kept; 12 of 116,443 rows, each whole: 1010338 (two
  points, EVSE ids), 1149546 (six points, Eichrecht keys), 1084823 (`In
Wartung`, no EVSE ids), 1085129 (`Kostenlos`, a cable plug), 1142486 and
  1150139 (plug and power lists in one slot), 1048651 (three points of two
  plugs), 1010374, 1148160 (a free-text EVSE-ID), 1137340 (`AC CEE
5-polig`), 1125796 (`Eingeschränkt` with weekday and time lists) and
  1033006 (no payment systems).
- `irve-static.csv` and `irve-dynamic.csv`: captured at 05:40 UTC on 2026-10-06
  from https://www.data.gouv.fr/api/1/datasets/r/eb76d20a-8501-400e-b336-d85724de5435
  (157,943,828 bytes by the dataset page, 158,188,323 received) and
  https://transport.data.gouv.fr/resources/84098/download, Licence Ouverte 2.0.
  The header and seven whole rows of the static file: the two PDCs of the
  station `FRBFCPVDIUF` (one out of service, one occupied, a tariff text);
  `FR073ERJ5G5279` and `FR073ESWBG5941` (`Mo-Fr 08:00-19:00`);
  `FR073E0HKH51125` (`Mo-Su 08:00-08:00`); `ATHTBE1012062` and
  `ATHTBE1012063` (`Non concerné` as the station id). The matching rows of the
  dynamic file, four of 124,424: both PDCs of `FRBFCPVDIUF` (`+00:00` with
  microseconds) and the two `ATHTBE` PDCs (`Z`). The file holds 224,488 rows
  of which 57,155 repeat a PDC id; the parser keeps the first.
- `afdc.json`: captured at 05:44 UTC on 2026-10-06 with the documented demo key
  (`DEMO_KEY`, NREL's public demo key) from
  `https://developer.nlr.gov/api/alt-fuel-stations/v1.json?fuel_type=ELEC&country=all&status=E&access=public&limit=3&api_key=DEMO_KEY`:
  stations 1523, 6355 and 6405, the envelope kept. `afdc-more.json` is four
  more single-station captures from the same endpoint with the filters
  `ev_charging_level=dc_fast&ev_network=Tesla` (83915, Canada),
  `ev_connector_type=NEMA1450` (48640), `status=P` (63615) and
  `ev_charging_level=dc_fast&ev_connector_type=J1772COMBO&ev_network=Electrify America`
  (121703, a unit with a CHAdeMO and a CCS cable), their `fuel_stations`
  joined into one answer. Licence: NLR Developer Network terms. No capture
  has a unit of several ports; the test writes that unit itself.
- `nobil.json`: a documentation sample, not a capture. The first station is
  the datadump example of the NOBIL API documentation (v3.0, rev. 16.08.2026,
  https://info.nobil.no/images/API_NOBIL_Documentation_v3_20260816.pdf),
  with its string breaks mended and its escapes written as characters; the
  documentation writes a single connector's attributes directly under
  `attr.conn`. The second station (`NOR_09001`) is written for the test from the
  attribute reference (https://nobil.no/admin/attributes.php): the
  connectors keyed by index, as the data export writes them, with an EVSE id,
  a `Type 2 + Schuko` outlet and an RFID accessibility. CC BY 4.0
  (NOBIL by Enova).
- `eipa-*.json`: documentation samples, not captures. They are the example
  values of the EIPA reader documentation (https://eipa.udt.gov.pl/reader/docs),
  copied from the earlier OpenMapX fixtures (`pl-eipa-*.json`): the real files
  are issued on registration. One file per reader role: `eipa-pool.json`,
  `eipa-station.json`, `eipa-point.json`, `eipa-operator.json`,
  `eipa-dictionary.json` and `eipa-dynamic.json` (statuses stamped
  2026-07-29, which the tests use as the fetch time).
- `cynap.xml`: captured at 04:08 UTC on 2026-10-06 with
  `curl -sS -m 60 -A "Mozilla/5.0"` from
  https://fixcyprus.cy/gnosis/open/api/nap/datasets/electric_vehicle_chargers/
  (386,467 bytes, 171 points), CC BY 4.0 (Department of Electrical and
  Mechanical Services, Cyprus). The envelope as published and 6 of the 171
  `chargingPoint` rows, whole: `Petrolina GSZ Station (150kW)` (Type 2 and
  CCS on a 300 kW DC point), `OneTower 2301 (22kW)` (`unavailable`, no
  operating time), `CY*EVP*ELCA0003` (44 kW over two Type 2 plugs of 22 kW,
  access text), `CY*EVP*ENIC0007` (weekly hours written as a Python dict),
  `TEC-NICOSIA-ZINAS-KANTHER` (Type 2 listed twice) and `LIDL-L104` (three
  plug types, free-text hours).
- `chargy.kml`: captured at 04:08 UTC on 2026-10-06 with
  `curl -sS -m 60 -A "Mozilla/5.0" -L` from
  https://data.public.lu/fr/datasets/r/22f9d77a-5138-4b02-b315-15f306b77034
  (which redirects to Chargy's own KML export; 693,184 bytes, 526
  placemarks), CC0 1.0 (Chargy / data.public.lu). The document head and 6
  placemarks, whole and on the file's single line: Esch-sur-Alzette Brill
  (`CHARGING`), Lorentzweiler Parking Mairie (`OFFLINE`), SuperChargy
  Junglinster (`PREPARING`, 160 and 350 kW), SuperChargy Capellen direction
  Luxembourg (`UNAVAILABLE`, a device of three connectors), CFL multimodal
  (`FINISHING`, `SUSPENDED_EVSE`) and Cité Herrenberg III (`FAULT`). No live
  connector was `RESERVED`, `OCCUPIED` or `FAULTED`; the test writes those
  states itself.
- `evroam.geojson`: captured at 23:02 UTC on 2026-10-05 from
  https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/EV_Roam_charging_stations/FeatureServer/0/query?where=1=1&outFields=*&f=geojson&resultRecordCount=2000
  (455,425 bytes, 638 features), CC BY 4.0 (Waka Kotahi NZ Transport Agency,
  EVRoam). 6 features, whole: OBJECTID 719366 (Ormiston, socketed and
  tethered AC groups), 719395 (bp charge Mangere, two CCS and two CHAdeMO),
  719417 (Paeratea, Type 1 CCS), 719705 (Waipapa, every group `Inoperative`),
  719878 (Epuni St, `Unknown` and `Inoperative`) and 719919 (Prestons,
  `is24Hours` `False`). Their `GlobalID`s and `OBJECTID`s are those of that
  day's reload.
- `tdx-station.json`, `tdx-live.json` and `tdx-rate.json`: captured in TDX's
  guest mode (no credentials; 20 calls a day per address) from
  `https://tdx.transportdata.tw/api/basic/v1/EV/{Station,ConnectorLiveStatus,ChargingRate}/City/Taipei?$top=10000&$format=JSON`,
  the stations and live states at 23:06 UTC on 2026-10-05, the rates at
  04:15 UTC on 2026-10-06. Open Government Data License, Taiwan, v1.0
  (交通部TDX平臺). The wrappers as published; the stations
  `33029464-STP6360001` (six Type 1 points of one gun each, no live state),
  `TPE0201U03` (two types, three points), `TPE0514` (two DC types, two guns
  per point, peak and off-peak rates) and `28371994-STP4900001` (one live
  state from 2026-01-05); every live row of the last three (16 of 1,627);
  and 7 of the 1,854 rate rows (two of `33029464-STP6360001`, all of
  `TPE0201U03`, the `C0094-1` and `C0095-1` connectors of `TPE0514`). No
  Taipei rate has a `DayType`; the weekday window is written by the test.
- `keco-info.json` and `keco-status.json`: documentation samples, not
  captures (the API needs a registered key). They are the JSON response
  examples of Korea Environment Corporation's OpenAPI guide
  (`한국환경공단_전기자동차 충전소 정보_OpenAPI활용가이드_v1.25.docx`, 2026-07-01,
  attached to https://www.data.go.kr/data/15076352/openapi.do), Korea Open
  Government License Type 1. The guide's JSON examples are not valid JSON
  (typographic quotes, no commas between items, `{생략}` for the elided
  items, stray spaces before the status example's values): the files hold
  the same fields and values in valid JSON, the values as the guide's XML
  examples write them. The tests add the chargers they need from the sample.
- `lta-batch.json`: a documentation sample, not a capture (DataMall answers
  only to a registered `AccountKey`). LTA DataMall API User Guide v6.10
  (1 Oct 2026, https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf):
  §2.29 says the batch file returns every charging point "in a single file"
  and gives only its link; the record fields and example values are those of
  §2.28, Singapore Open Data Licence v1.0. The first location is the guide's
  example (`123 Road A`; the guide leaves the charger `id` blank, written
  here as the evId's registration code). The second, `45 Example Avenue`,
  is written for the tests from the same attribute table: a charger with a
  DC and an AC plug type priced per kWh and per hour and two evIds, one
  occupied and one available (the charger's own status 1), and a charger
  with one evId not available. The file's envelope is undocumented; it is written as
  DataMall's `{ "value": [...] }`, and the parser also takes a bare list.
- `ocm.json`: full objects as the API returns them with `compact=false`,
  built from the public export `openchargemap/ocm-export` (commit
  `8e3bedca`, 2026-04-22): the records `data/LU/OCM-32021.json` (provider 26,
  Oplaadpalen.nl, CC BY-NC-SA 3.0), `data/SI/OCM-77677.json`,
  `data/US/OCM-7708.json` (provider 15, CarStations.com, no licence),
  `data/IE/OCM-311421.json` and `data/US/OCM-8538.json`. The export is
  written with `compact=true`, reference ids only; each id is replaced by
  the object of the same id in the export's `data/referencedata.json`
  (`DataProvider`, `OperatorInfo`, `UsageType`, `StatusType`,
  `SubmissionStatus`, `AddressInfo.Country`, and per connection
  `ConnectionType`, `StatusType`, `Level`, `CurrentType`), the shape the
  OpenAPI description's POI example shows. `MediaItems` and `UserComments`
  are left out. The API itself needs a key. Data licences per record as
  named by its `DataProvider`.
