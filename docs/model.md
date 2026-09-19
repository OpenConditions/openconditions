# The OpenConditions data model

`@openconditions/model` (Apache-2.0) is the typed model every OpenConditions
record follows, and the registry that closes its taxonomy. It has no
dependency on any other OpenConditions package: storage, ingest, publishers,
federation and third parties all build on it.

## Records

Every record shares one kernel — id, class, kind/type/subtype, domain,
temporality, location, provenance, freshness, validity, relations — and is one
of four classes:

| class         | what it is                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `feature`     | a persistent thing with a lifecycle (a charger, a car park, a gauge), with addressable components          |
| `situation`   | a bounded-in-time condition: `type` is its nature, `causes[]` why, `effects[]` what it does to travel      |
| `observation` | a timestamped result for a registered property about a feature, component, segments, location or situation |
| `offer`       | a structured tariff on a feature or component                                                              |

Record ids are `oc:<class>:<namespace>:<localId>`. The namespace is a source id
(`[a-z0-9-]+`) or, for records an instance originates, its instance id (a
hostname works); it never contains `:`. `canonicalId` is
`sha256([namespace, localId])`.

`Effect` is the single routing and impact contract: closures, lane
restrictions, speed and dimension limits, access rules, hazmat rules, detours,
contraflow, advisories and — for a restriction a parser recognised but could
not type — `unsupported`. An effect whose applicability is `unknown` or whose
normalization is not `complete` is restriction evidence: stored and listed,
withheld from shared routing.

## Registry

Domain packages contribute registry modules; one `buildRegistry([...])` call
assembles them with the kernel module into a closed registry and fails at
startup on any inconsistency (unknown domain or vocabulary, duplicate code,
closed vocabulary extended, malformed version).

```ts
import { buildRegistry, defineKind, kernelModule } from "@openconditions/model";
import { z } from "zod";

const registry = buildRegistry([
  kernelModule,
  {
    name: "roads",
    entries: [
      defineKind({
        class: "situation",
        code: "incident",
        domain: "roads",
        version: "1.0",
        description: "Unplanned events on the road",
        types: { accident: ["multi_vehicle", "overturned"] },
        details: () => ({ vehiclesInvolved: z.number().int().optional() }),
      }),
    ],
  },
]);

registry.validateDraft(parserOutput); // derived fields must be absent
registry.validate(storedRecord); // derived fields must be present and consistent
```

- `defineDomain`, `defineVocabulary` / `extendVocabulary` — closed and
  registry-extensible value lists (extensible ones grow with the modules that
  extend them; the assembled list is a closed enum).
- `defineKind` — feature, component, situation and offer kinds, with their
  closed type/subtype lists and `details` schema.
- `defineProperty` — observation properties: result form, canonical unit or
  vocabulary, allowed subjects, qualifiers, retention and fusion metadata.
- `defineEffect`, `defineSelector`, `defineResultSchema` — effect variants,
  `Situation.affects` keys and structured observation results.

Validation is hard: every object is closed, controlled values come only from
registered vocabularies, and dispatch is by `(class, kind | property, v)`.

The packages are layered so the assembled registry never depends on parsers or
storage:

| package                          | holds                                                                                       | depends on                 |
| -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| `@openconditions/model`          | kernel and registry framework                                                               | no OpenConditions package  |
| `@openconditions/model-<domain>` | one domain's registry module: kinds, properties, effects, vocabulary extensions, crosswalks | `model` only               |
| `@openconditions/model-registry` | `productionRegistry()`: the kernel plus every domain module, and the published JSON Schemas | `model` and `model-*` only |

Services, publishers and federation validate and seal with
`productionRegistry()`; storage and the domain parser packages never import it.
The database CHECKs only vocabularies the kernel closes itself; columns whose
values domain modules contribute (kinds, properties, domains, source formats,
effect kinds) are guarded by the write seam, not by a constraint.

## Versioning

Every entry has a `major.minor` version; the wire carries the major (`v` on
`details`, on each effect and on structured results). Adding an optional field
bumps the minor; removing, renaming or retyping a field bumps the major. An
instance validates only the current major of each entry. The kernel itself is
versioned too (`kernel@1.0`) and negotiated at federation like a kind.

## Drafts and stored records

Parsers produce drafts. The write seam (`sealRecord`) derives `canonicalId`,
`domain`, `provenance.instanceId` and `contentHash`; storage assigns `revision`
and `recordedAt`. A draft that asserts a derived field is rejected.

The content hash covers content only. Which record keys count as content is
declared per class in a map the typechecker holds complete: a new field cannot
be added to a class without deciding whether it changes a record's revision.
Freshness, identity, evidence, OSM matching, the raw payload reference and
provenance hop metadata never do.

## Published artifacts

`pnpm gen:model` writes the JSON Schema of every registry entry to
`packages/model-registry/schemas/` (`kernel@1.json` holds the kernel `$defs`; each
kind, property, effect, selector and result schema has its own file, listed in
`index.json`) and regenerates the section below. `pnpm check:model` and the
artifacts test fail when either is stale.

## Environment fit check

Before the kernel hardened, three real environmental records were mapped onto
it with a test-only `environment` module (`environment-fit.test.ts`; the
domain itself stays unregistered until OpenConditions ingests such data):
a PEGELONLINE river gauge (Köln), a Sensor.Community citizen node, and an ECCC
AQHI station. All three fit Feature, Component and Observation. What they
changed:

- A linear reference names any linear feature — `LinearRef.ref` ("RHEIN",
  km 688), not a road-only `roadRef`.
- Component kinds are registry-contributed like feature kinds: a citizen node
  is a feature with one `sensor` component per device, and its readings are
  keyed by component and property.
- Sources get a tier (`source_tier`: `authoritative`, `operator`,
  `aggregator`, `community`) and fusion ranks by it, so a citizen network sits
  below an authority. A citizen node never links to an official station
  (different kind), so the tier matters where two publishers carry the same
  asset.
- Qualifiers that identify a series are required: an air-quality index without
  its `scale` is rejected, so a Canadian AQHI never shares a series with a
  European EAQI; concentrations (`air.pm2_5`) and indices (`air.index`) are
  separate properties and never fuse.
- Home-sited sensors are published at coarsened positions
  (`fuzziness: "low_res"`); spatial identity linking will require exact
  positions on both sides.
- Source timestamps without a zone designator (Sensor.Community) are rejected
  until ingest adds one.

## Registry reference

<!-- generated:registry:start -->

Kernel version `1.0`; modules: `kernel`.

### Domains

None registered yet (domain packages contribute them).

### Vocabularies

| vocabulary                | extensible | values                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_mode`             | no         | `bulk`, `on_demand`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `action_status`           | no         | `requested`, `approved`, `being_implemented`, `implemented`, `rejected`, `termination_requested`, `being_terminated`                                                                                                                                                                                                                                                                                                                         |
| `admin_geocode_scheme`    | yes        | `iso3166-2`, `nuts`, `fips`, `same`, `ugc`, `ars`                                                                                                                                                                                                                                                                                                                                                                                            |
| `aggregation`             | no         | `instantaneous`, `mean`, `median`, `min`, `max`, `sum`, `p85`, `typical`                                                                                                                                                                                                                                                                                                                                                                     |
| `amenity`                 | yes        | —                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `carriageway`             | no         | `main`, `entry`, `exit`, `ramp`, `connector`, `service`, `collector`, `parallel`                                                                                                                                                                                                                                                                                                                                                             |
| `cause`                   | yes        | `accident`, `breakdown`, `debris`, `spill`, `fire`, `police_activity`, `animal`, `congestion`, `hazard`, `weather`, `roadworks`, `maintenance`, `construction`, `public_event`, `security`, `infrastructure_failure`, `equipment_failure`, `flooding`, `landslide`, `avalanche`, `wildfire`, `strike`, `demonstration`, `medical_emergency`, `obstruction`, `abnormal_load`, `military`, `customs`, `unknown`, `other`                       |
| `certainty`               | no         | `observed`, `likely`, `possible`, `unlikely`, `unknown`                                                                                                                                                                                                                                                                                                                                                                                      |
| `compliance`              | no         | `mandatory`, `advisory`, `unknown`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dimension`               | no         | `height`, `width`, `length`, `gross_weight`, `laden_weight`, `axle_load`, `axle_count`, `trailer_count`                                                                                                                                                                                                                                                                                                                                      |
| `direction_basis`         | no         | `road_reference`, `alert_c`, `openlr`, `bearing`, `compass`, `text`, `unknown`                                                                                                                                                                                                                                                                                                                                                               |
| `direction_value`         | no         | `positive`, `negative`, `both`, `unknown`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `emission_scheme`         | yes        | `euro`, `de_plakette`, `crit_air`, `ulez`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ended_reason`            | no         | `source_ended`, `withdrawn_from_feed`, `expired`, `superseded`, `cancelled`, `stale`                                                                                                                                                                                                                                                                                                                                                         |
| `evidence_state`          | no         | `self_reported`, `corroborated`, `externally_resolved`, `negated`, `expired`                                                                                                                                                                                                                                                                                                                                                                 |
| `extent`                  | no         | `point`, `linear`, `area`, `network`, `none`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `external_id_scheme`      | yes        | `ocpi:location`, `ocpi:evse`, `ocpi:connector`, `oicp:evse`, `emi3:evse`, `datex:site`, `datex:situation`, `datex:record`, `datex:parking`, `datex:vms`, `datex:refill_point`, `wzdx:road_event`, `wzdx:device`, `open511`, `tpims:site`, `nbi:structure`, `fra:crossing`, `cbp:port`, `cbsa:office`, `osm:node`, `osm:way`, `osm:relation`, `gers`, `wikidata`, `tmc`, `cap`, `gtfs:stop`, `gtfs:route`, `ocm`, `bnetza`, `cpo`, `provider` |
| `fusion_tier`             | no         | `authoritative`, `operator`, `aggregator`, `community`, `crowd_externally_resolved`, `crowd_corroborated`, `crowd_self_reported`                                                                                                                                                                                                                                                                                                             |
| `fuzziness`               | no         | `exact`, `low_res`, `medium_res`, `end_unknown`, `start_unknown`, `extent_unknown`                                                                                                                                                                                                                                                                                                                                                           |
| `geometry_origin`         | no         | `source`, `site_table`, `tmc_table`, `openlr_decoded`, `osm`, `crowd_device`, `derived`, `none`                                                                                                                                                                                                                                                                                                                                              |
| `grant_state`             | no         | `yes`, `no`, `unknown`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ical_day`                | no         | `MO`, `TU`, `WE`, `TH`, `FR`, `SA`, `SU`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `issue_code`              | yes        | `unsupported_type`, `unsupported_unit`, `unsupported_operator`, `invalid_value`, `invalid_window`, `unsupported_schedule`, `unsupported_status`, `unknown_vehicle`, `compound_condition`, `conflicting_direction`, `unresolved_lane`                                                                                                                                                                                                         |
| `lane_type`               | no         | `general`, `hov`, `bus`, `bicycle`, `shoulder`, `hard_shoulder`, `emergency`, `turn`, `exit`, `entrance`, `median`, `center_turn`, `ramp`, `parking`, `sidewalk`                                                                                                                                                                                                                                                                             |
| `lifecycle`               | no         | `planned`, `under_construction`, `operational`, `temporarily_closed`, `decommissioned`, `unknown`                                                                                                                                                                                                                                                                                                                                            |
| `los`                     | no         | `free_flow`, `slow`, `heavy`, `queuing`, `stationary`, `blocked`, `unknown`                                                                                                                                                                                                                                                                                                                                                                  |
| `normalization`           | no         | `complete`, `partial`, `unsupported`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `origin`                  | no         | `feed`, `crowd`, `federation`, `derived`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `payment_method`          | no         | `cash`, `credit_card`, `debit_card`, `contactless`, `app`, `rfid`, `sms`, `membership`, `direct_debit`, `free`, `other`                                                                                                                                                                                                                                                                                                                      |
| `privacy_class`           | no         | `authoritative`, `aggregate`, `k_anon`, `dp_noised`, `crowd_pseudonym`                                                                                                                                                                                                                                                                                                                                                                       |
| `record_class`            | no         | `feature`, `situation`, `observation`, `offer`                                                                                                                                                                                                                                                                                                                                                                                               |
| `relation`                | no         | `part_of`, `monitors`, `controls`, `serves`, `group`, `next_occurrence`, `first_occurrence`, `related_work_zone`, `caused_by`, `detour_for`, `supersedes`, `update_of`, `cancels`, `related`                                                                                                                                                                                                                                                 |
| `result_type`             | no         | `quantity`, `count`, `boolean`, `category`, `text`, `vector`, `money`, `structured`, `unknown`, `not_applicable`                                                                                                                                                                                                                                                                                                                             |
| `road_class`              | no         | `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `local`, `service`, `other`                                                                                                                                                                                                                                                                                                                                                         |
| `road_designation_scheme` | yes        | `us_interstate`, `us_route`, `us_state_route`, `de_bab`, `de_bundesstrasse`, `e_road`, `national`                                                                                                                                                                                                                                                                                                                                            |
| `severity`                | no         | `minor`, `moderate`, `major`, `critical`, `unknown`                                                                                                                                                                                                                                                                                                                                                                                          |
| `source_format`           | yes        | `crowd`, `derived`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `source_tier`             | no         | `authoritative`, `operator`, `aggregator`, `community`                                                                                                                                                                                                                                                                                                                                                                                       |
| `temporality`             | no         | `static`, `scheduled`, `live`, `forecast`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tombstone_reason`        | no         | `expired`, `withdrawn`, `superseded`, `cancelled`, `rights_revoked`, `rejected`                                                                                                                                                                                                                                                                                                                                                              |
| `validity_status`         | no         | `planned`, `active`, `suspended`, `ended`, `cancelled`, `unknown`                                                                                                                                                                                                                                                                                                                                                                            |
| `vehicle_class`           | no         | `motor_vehicle`, `car`, `van`, `truck`, `hgv`, `bus`, `coach`, `motorcycle`, `moped`, `bicycle`, `pedestrian`, `trailer`, `caravan`, `agricultural`, `emergency`, `taxi`, `oversize`, `abnormal_load`                                                                                                                                                                                                                                        |
| `vehicle_fuel`            | no         | `electric`, `hydrogen`, `lpg`, `cng`, `lng`, `diesel`, `petrol`, `hybrid`                                                                                                                                                                                                                                                                                                                                                                    |
| `vehicle_usage`           | no         | `emergency_services`, `public_transport`, `taxi`, `delivery`, `residents`, `permit_holders`, `military`, `agricultural`, `car_sharing`                                                                                                                                                                                                                                                                                                       |

### Effects

| effect             | version | description                                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `closure`          | 1.0     | The road element is closed. Individual lanes or the hard shoulder closed = lane_restriction, never a closure.            |
| `lane_restriction` | 1.0     | Lane-level impact (WZDx VehicleImpact, snake_cased).                                                                     |
| `speed_limit`      | 1.0     | A (temporary) speed limit in km/h.                                                                                       |
| `delay`            | 1.0     | Expected delay, queue and level of service.                                                                              |
| `access`           | 1.0     | An access rule for the vehicles in `applicability`.                                                                      |
| `dimension_limit`  | 1.0     | A maximum permitted vehicle dimension, in the dimension's canonical unit.                                                |
| `hazmat`           | 1.0     | Dangerous-goods restriction. ADR tunnel category A means no restriction and is never an effect.                          |
| `detour`           | 1.0     | A signed or described diversion.                                                                                         |
| `contraflow`       | 1.0     | Traffic runs against the normal direction on part of the carriageway.                                                    |
| `advisory`         | 1.0     | Advice without a typed rule.                                                                                             |
| `unsupported`      | 1.0     | Carrier for a source restriction the parser recognised but could not type; always normalization unsupported with issues. |

### Situation selectors

| selector   | version | description                                                       |
| ---------- | ------- | ----------------------------------------------------------------- |
| `features` | 1.0     | Features (or, with componentKey, components) a situation affects. |

<!-- generated:registry:end -->
