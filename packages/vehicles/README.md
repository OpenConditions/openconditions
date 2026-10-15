# @openconditions/vehicles

The vehicles ingest domain of OpenConditions: the feed shape, the product
(`maintenance`) and the formats that turn a road authority's fleet tracking
into the `vehicle.position` readings of `@openconditions/model-vehicles`.

- `src/formats/digitraffic.ts` is the `digitraffic` format: Fintraffic's road
  maintenance tracking (`/api/maintenance/v1/tracking/routes/latest`), the
  latest point of every work machine. Digitraffic publishes no machine id,
  and a tracking id lasts seconds to minutes, so each point is an anonymous,
  transient `vehicle.position` reading at its location, standing ten minutes
  from the time the vehicle reported it; a point already older is a vehicle
  that stopped reporting and is left out. Every poll restates each vehicle's
  latest point (`restatesTransient`), so the position a vehicle moved on from
  ends with the next poll rather than standing beside the new one. Ploughing puts the plough down (`plowUp: false`),
  salting and sanding turn the spreader on, and the publisher's task codes
  stay on the reading's extras. The format may answer with no vehicle out.

The domain builds on the kernel and the vehicles model module, never on the
assembled registry. See [feeds/README.md](../../feeds/README.md) for how a
feed is written.
