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
