# @openconditions/border

The border ingest domain of OpenConditions: the feed shape, the product
(`waits`) and the formats that turn the border agencies' wait-time
publications into the `border_crossing` features, `lane_group` components and
`border.wait` readings of `@openconditions/model-border`, with the crossing's
`facility.open_status` where the agency states it.

- `cbp-bwt`: U.S. Customs and Border Protection's Border Wait Times API
  (`https://bwt.cbp.gov/api/bwtnew`), every U.S. land port on the Canadian
  and Mexican borders with its U.S.-bound queues: commercial, passenger and
  pedestrian lanes, each standard, FAST, NEXUS/SENTRI or Ready Lane. A queue
  CBP marks N/A gets no lane group. Queue times carry no date and wrong zone
  labels, so the port's zone from the crossing table dates them, corrected by
  the hour a port's clock runs off it (read from the page time CBP writes for
  one instant at every port).
- `cbsa-bwt`: the Canada Border Services Agency's CSV
  (`https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv`), the Canada-bound
  commercial and traveller waits at its busiest offices, keyed by office name.
- `src/crossings.ts` and `src/snapshots/crossings.json`: the vendored crossing
  table. Neither agency publishes coordinates, and CBSA no office id, so each
  crossing names the Wikidata item it is, the CBP port numbers and CBSA office
  names that report it, and the IANA zone its clocks keep; the item's English
  label and coordinate location are copied from Wikidata (CC0 1.0) by
  `pnpm tsx scripts/gen-border-crossings.ts`, which also warns where a
  crossing lies far from the point the Bureau of Transportation Statistics
  publishes for its CBP port (public domain), and with `--feeds` lists the
  ports and offices the live feeds name that the table lacks. A port the
  table lacks is rejected, not guessed. Both agencies' features of one crossing
  share its place and its Wikidata id, so they link.

The domain builds on the kernel and the border model module, never on the
assembled registry. See [feeds/README.md](../../feeds/README.md) for how a
feed is written.
