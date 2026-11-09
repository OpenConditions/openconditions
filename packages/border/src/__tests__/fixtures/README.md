# Border fixtures

- `cbp-bwtnew.json`: 11 of the 85 ports of `https://bwt.cbp.gov/api/bwtnew`
  (sent `Accept: application/json` and `Accept-Language: en-US`), fetched
  2026-10-14T23:38:05Z; CBP wrote the page at 23:33:33Z. Kept as served,
  pretty-printed. The ports cover a queue N/A, closed, pending and stated;
  "no delay" with minutes; a closed port (Milltown); zone labels that are
  wrong (Port Huron's EST in October, Douglas's PST in Arizona); clocks an
  hour ahead of their zone (San Luis II, Nogales Mariposa); an update time
  after the fetch (Alexandria Bay's 9:00 pm, yesterday's); and a port the
  crossing table lacks (240221, El Paso, no crossing named). Public domain
  (U.S. Government work, CBP copyright notice).
- `cbp-bwtnew-es.json`: 3 ports of the same API in CBP's Spanish edition,
  from the Internet Archive's capture of 2026-06-26T21:06:20Z
  (`https://web.archive.org/web/20260626210620id_/https://bwt.cbp.gov/api/bwtnew`).
- `cbsa-bwt-eng.csv`: `https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv` as
  served (byte-order mark, `;;` separators, CRLF), all 30 offices, fetched
  2026-10-14T23:38:07Z. Open Government Licence – Canada (the "Current Border
  Wait Times" dataset of the Open Government Portal).

## Granica

`granica-2026-11-08.html.txt` contains the exact anonymous Polish country-page response bytes captured on 2026-11-08; the adjacent receipt records the URL, retrieval instant, size and SHA-256. The `.txt` suffix keeps formatting tools from rewriting provider HTML or its scripts. Scripts are never executed. Only the numerical outbound car/truck product is extracted under dataset 1694's CC BY 4.0 grant and explicit website/service equivalence. This is not a licence grant for surrounding website content, images or notices. Synthetic edge cases are labelled in the tests and derive from this capture.

The capture reports freight waits of 16:00, 14:00 and 25:00 at Medyka, Korczowa and Hrebenne, and passenger waits of 2:00, 1:00 and 0:00. DMC means permissible gross mass. The adapter retains the >7500 kg restriction in typed lane eligibility, and estimates waiting to begin clearance. It makes no assertion about facility openness or total crossing duration.

`granica-geometry-evidence.json` identifies the independent Wikidata structured-coordinate statements, revisions and retrieval method. Medyka's JSON was directly captured; the two other entity JSON refreshes returned 403. Their revision-specific indexed entity pages supplied the structured CC0 statements. These joins are not fresh direct API qualification, and contain no silently imported OSM geometry. Decimal coordinates for those two statements are arithmetic conversions of their sexagesimal values. The railway Hrebenne entity is excluded.

`granica-2026-11-09.html.txt` retains only the country table, with CRLF and lone CR converted to LF, from the 2026-11-09T18:26:35.741420Z response. Its receipt binds the full response hash, raw table hash and length, normalized table hash and length, and newline transformation and transcribes the six included waits independently: Medyka 120/600, Korczowa 0/180, Hrebenne 0/780 minutes (car/freight). The source date is November 9; crossing minutes 19:00, 19:01 and 19:22 mean 18:00Z, 18:01Z and 18:22Z under the Warsaw interpretation. Response Date and Last-Modified describe transport and do not renew those publications.

On November 9 the two previously blocked Wikidata entity JSON requests returned HTTP 200 at the same recorded revisions. The geometry receipt now records direct retrieval instants and response hashes for both. Earlier 403 evidence remains in the external implementation report and the receipt's prior-refresh fields. Their structured P625 values are retained directly; there is no OSM geometry import.
