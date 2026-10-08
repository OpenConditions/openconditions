# DATEX II fixtures

Parking fixtures (`ndw-truck-*`, `cita-*`) are the copies kept in
`packages/parking/src/__tests__/fixtures`, see that README.

## Energy infrastructure

| File                   | Source                                                                                                  | Licence      | Captured   | Records kept                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `es-dgt-energy.xml`    | DGT national access point, `…/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml` | CC-BY-4.0    | 2026-07-28 | Three whole sites with the real header: a 24/7 on-street site, a site with a free-text weekly timetable, a 24/7 open-space site with several refill points                            |
| `si-nap-energy.xml`    | NAP Slovenija, Prometej IDACS Energy Infrastructure Table (v3 sample)                                   | CC-BY-SA-4.0 | 2025-12-04 | Three whole sites from the published sample (the endpoint itself needs an account): a DC site, a Gorenje site with `RateTable` prices, and a bicycle charger; no `d2:payload` wrapper |
| `lt-energy-status.xml` | `https://ev.vialietuva.lt/publicdata/EnergyInfrastructureStatusPublication`                             | CC-BY-4.0    | 2026-10-06 | Five whole site statuses out of 3,706, covering AVAILABLE, CHARGING, INOPERATIVE, OUTOFORDER, REMOVED and `Unknown`; the header is as captured                                        |

## Device publication (cameras)

| File                 | Source                                                                                                    | Licence   | Captured   | Records kept                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `es-dgt-cameras.xml` | `https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml`, Dirección General de Tráfico | CC-BY-4.0 | 2026-10-08 | Three whole camera devices out of 1,956 (176130, 2 and 167979, the last with no `roadDestination` and a `both` road direction) with the real header and DGT's `levelC` namespaces and prefixes as served |

Every device in the live capture is a camera. Device `9999001`, a
`variableMessageSign`, is hand-made (not DGT data) so the decoder's skipping of
non-camera devices is tested.

The Lithuanian capture declares `modelBaseVersion="3"` and the
`https://datex2.eu/schema/3/energyInfrastructure` namespace without a minor
version. Its status elements are `energyInfrastructureSiteStatus`,
`energyInfrastructureStationStatus` and `refillPointStatus/status`, which are
the names in DATEX II v3.7 `DATEXII_3_EnergyInfrastructure.xsd`. It carries
`id`/`version` and `connectorIndex` attributes on the status elements where
v3.7 has a `reference` child, and writes the status values in upper case.
