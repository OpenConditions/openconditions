# Main Roads WA WebEOC fixture

`live.geojson` is the unmodified public layer-4 response captured on 2026-11-07 at approximately 04:50 UTC. It contains five externally published caution LineStrings (15,933 bytes). The exact capture URL is in `query.txt`. This count describes one response, not all WA incidents. The coordinates were requested in EPSG:4326. No account, credential or personal enrichment was used.

The source is [WebEOC Road Closures](https://catalogue.data.wa.gov.au/en/dataset/mrwa-webeoc-road-closures), owned by [Main Roads WA](https://www.arcgis.com/sharing/rest/content/items/6bb807d09b37476f83a073cb4660e932?f=pjson), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The Commissioner of Main Roads is the creator and owner of the data and Licenced Material, which is accessed pursuant to a Creative Commons (Attribution) Licence, which has a disclaimer of warranties and limitation of liability.

The tests modify copies to exercise closed, conditional, detour, unknown, unpublished, duplicate, malformed and multipart cases. Those cases are synthetic and do not demonstrate live provider behavior. The original caution sample includes lane closure and speed-reduction prose; that prose does not establish numeric restrictions or universal permission.

The parser rejects conflicting records sharing an identity, including separate geometry parts it cannot safely reconcile. A genuine GeoJSON MultiLineString retains every part. GlobalID is preferred, followed by publisher Id and then FID, with distinct namespaces. FID fallback does not establish refresh persistence. Invalid geometry is accounted as unlocatable; missing identity or unknown publication state invalidates the poll. Failed acquisition and malformed pages throw before publication.

The catalogue deliberately does not declare complete-snapshot disappearance. Enable it only after repeated refreshes establish GlobalID lifetime, multipart and authoritative withdrawal behavior. Repeat CRS and endpoint checks after the scheduled 13–16 November 2026 GDA2020 transition. No sustained polling, real closed/conditional/detour sample, withdrawal sequence, production or native-client acceptance is claimed. String date timezone and update meaning remain unknown, so no source update or occurrence instant is emitted.
