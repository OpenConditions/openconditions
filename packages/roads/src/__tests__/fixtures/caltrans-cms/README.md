# Caltrans CMS captures

The four `.json.raw` files (JSON transport bytes) are unmodified bounded public district GET responses. `capture.json` records the endpoint, retrieval clock, digest, byte count and source row count. These sequential responses do not establish an atomic statewide snapshot, a device census or sustained health. The legal basis is [Caltrans Conditions of Use](https://dot.ca.gov/conditions-of-use), dated July 19, 2021, for agency-owned CMS data; ownership exceptions remain applicable. Credit: Caltrans.

D03 contains repeated indexes and a Sacramento longitude typo. D02 has two location placeholders. D11 has missing wire districts and repeated indexes. D12 uses the same index throughout and includes a test modem with longitude `-0.117775`, which is excluded. Unit tests construct synthetic display, correction, ambiguity and DST cases from these captured rows; those mutations are not provider observations.
