# @openconditions/model-charging

The charging registry module of the OpenConditions data model: the `charging`
domain, the `charging_site` feature kind with its `evse` and `connector`
components, the status properties (`charging.evse_status`,
`charging.connector_status`, `charging.site_status`,
`charging.waiting_time`), the `energy_tariff` offer, the `evse_status`,
`charging_site_status` and `connector_standard` vocabularies, and the
crosswalks from OCPI 2.2.1 and DATEX II v3 energy infrastructure.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
