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
