# CWA O-A0003-001 fixture

`tw-cwa-preview.txt` is the exact UTF-8 response captured from https://opendata.cwa.gov.tw/webapi/datasetContent/O-A0003-001 on 2026-11-08 at 06:25:06 UTC. The source observation is 2026-11-08T14:10:00+08:00. This bounded public UI preview contains one station, 466940; it is neither a complete census nor a runtime endpoint. No credentials were sent. Tests mutate copies for synthetic edges and use a synthetic operator key with an in-process fetch double only.

Credit: Central Weather Administration / 交通部中央氣象署, O-A0003-001 氣象觀測站-10分鐘綜觀氣象資料. 此開放資料依政府資料開放授權條款 (Open Government Data License), 第1版, 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。 https://data.gov.tw/license

The field standard V1.05 (2025-07-17), https://opendata.cwa.gov.tw/opendatadoc/Observation/O-A0003-001.pdf, and https://opendata.cwa.gov.tw/apidoc/v1 were read on 2026-11-08. The exact dataset's OGDL assignment is https://data.gov.tw/dataset/9178; platform rules are https://opendata.cwa.gov.tw/about/rules (published text in https://opendata.cwa.gov.tw/dist/js/30.5de985aa.js). The standard establishes current percentage humidity and mean wind, but does not establish a precise daily precipitation reset convention or wind averaging duration.

The catalogue remains disabled until an operator qualifies a complete unfiltered authenticated REST response, its size, measured freshness, pagination, quota and caching. The 600-second cadence is a conservative polling choice, not a provider quota. Precipitation is withheld, including trace, missing codes, zero and positive daily totals, until the local-day interval is established. Observation absence never closes a station; unqualified snapshots cannot authorize feature/offer withdrawal. Model freshness is applied per property from measurement time, with expiry retained through the API, independently of fetch time.

Capture SHA-256: `37ab93a8f517c80b1da9d28bf7dfcc7a06b96b71f12663ca79e07456f4155a04`; 3310 bytes.
