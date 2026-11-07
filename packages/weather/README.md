# @openconditions/weather

The weather ingest domain of OpenConditions: the feed shape, the product
(`weather`) and the formats that turn road weather station publications into
the `weather_station` features and the `weather.*` and `road.*` readings of
`@openconditions/model-weather`.

- `src/station.ts` builds the records every format shares: a station with its
  road-surface value streams as `sensor_channel` components, and a reading of
  the station or one of its channels, dated by the publisher's measurement
  time and stating the window a mean or maximum covers.
- `digitraffic-weather` (`src/formats/digitraffic.ts`): Fintraffic
  Digitraffic's road weather API (v2). It reads the station list (`sites`)
  hourly, each station's details (`details`) daily and every station's
  latest values (`status`) every five minutes.
  `src/formats/digitraffic-sensors.ts` is the table of the publisher's
  sensors it reads, with their units, windows and code tables, and says which
  it leaves out and why. Air values are the station's own readings; each
  road-surface value is a channel keyed by the publisher's sensor id, so
  numbered surface sensors stay separate series. A value marked faulty, in
  another unit than its sensor's, or older than its property's freshness
  window is not read; nor is the fault code a station states for a numbered
  sensor it does not have, nor the salt concentration and freezing point of
  a sensor measuring no water film. The list's maintenance state of a
  station (`state`) is its `device.status`.

The domain builds on the kernel and the weather model module, never on the
assembled registry. See [feeds/README.md](../../feeds/README.md) for how a
feed is written.

## DWD CDC current observations

`dwd-cdc-10min` reads four `now/` products: air temperature/dew point/humidity, mean wind, maximum gust and ten-minute precipitation amount. Each product has a daily station-table role, an hourly listing role and a versioned ZIP role. ZIP filenames, listing modification times and sizes form acquisition versions; unchanged versions are revalidated after an hour to detect same-minute, same-size corrections. Walks are capped at 1,600 archives per product and use the framework's guarded requests, timeouts, retries and bounded ZIP decoding. The catalogue's 60 requests/minute is an operator-selected cap, not a DWD quota.

The feed remains disabled. The worker also blocks acquisition until full-fanout request, byte, cancellation/deadline and freshness budgets have been qualified. Changing only the catalogue cannot activate it. The historical listing sample contained 2,389 archives; this is neither a station census nor evidence of a ten-minute nationwide service level. No full-load qualification has been performed.

Station metadata supplies current source-epoch WGS84 coordinates, names and validity dates. Observations outside those dates are excluded; conflicting product coordinates fail the generation. This parser does not reconstruct relocations or historical geography. Metadata-only and archive-only IDs are counted as rejected, and station lifecycle remains unknown. Directory membership never authorizes station deletion: publication retains absent station features. Operator-reviewed population/deletion qualification is required before introducing a complete station snapshot.

Measurements use twelve-digit UTC calendar times. Invalid and future clocks fail before the shared reading helper can clamp them. Values older than one hour are omitted; every channel selects its own latest usable value. `-999` is missing per field, zero is valid, and source QN codes are retained without claiming certification. Pressure, near-ground temperature, solar radiation, precipitation type/rate, road conditions and device status are not emitted. The four products use canonical Cel, %, m/s, deg and mm with ten-minute windows. See [capture provenance and dataset citations](src/__tests__/fixtures/dwd/README.md) for rights and source evidence.
