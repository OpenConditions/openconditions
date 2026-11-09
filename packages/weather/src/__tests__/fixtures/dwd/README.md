# DWD CDC captures

These are fourteen bounded anonymous HTTPS responses: four `now/` listings, four Latin-1 station tables and one measurement ZIP per product plus two September leftover archives. `provenance.json` records the original URL, retrieval instant, byte count and SHA-256 for each unchanged body. They are samples, not a national measurement census. Listings are fixture inputs only; ordinary CI must not crawl them live.

Quelle: Deutscher Wetterdienst. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) under the [CDC terms, May 2024](https://opendata.dwd.de/climate_environment/CDC/Terms_of_use.pdf). Fixture bytes are unchanged; the parser normalizes station identifiers, text encoding, timestamps and units. Test cases constructed from these captures are explicitly altered in test code.

Dataset citations: _10-minute station observations of air temperature for Germany_, _10-minute station observations of wind for Germany_, _10-minute station observations of extreme wind for Germany_, and _10-minute station observations of precipitation for Germany_, Version v24.03, publication date 2024-03-29. Product descriptions reside beside each product's `now/` directory under [CDC 10-minute observations](https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/). Documentation publication and regeneration dates are not observation times.

The selected products include legally equivalent partner networks. Network membership does not imply a licence exception. Actual non-`Frei` station flags are withheld; the existing public-egress filter still applies to explicitly restricted upstream provenance. Graphics, photographs, maps and satellite products are outside this feed.
