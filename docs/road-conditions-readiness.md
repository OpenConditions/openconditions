# Road-condition reliability acceptance

Run the seven-day poll report against the staging database after the additive
metadata and shadow-routing release:

```sh
DATABASE_URL='postgres://…' pnpm road-conditions:readiness
```

The report derives network reliability only from actual network outcomes:
`changed`, `validated_unchanged`, `complete_empty`, `partial`, and `failed`.
Local cadence/overlap skips and missing configuration remain visible in
`conditions.source_poll_attempt`, but do not inflate or reduce the network
success rate. `networkReliabilityReady` requires at least 99% successful
validation. `pollSoakReady` additionally requires observations spanning the full
seven-day window, a current final validation, and no validation gap longer than
the source freshness window. A single successful poll can therefore never pass
the soak. This remains a poll-only result: operators must still check
`/feeds/status` for a current freshness deadline, graph readiness, binding
buckets, rights, rejected records, and partial snapshots before enabling route
effects.

The admitted pilot descriptors preserve exact evidence:

- `fr-dir`: Licence Ouverte 2.0, source and derived redistribution, commercial
  reuse and retention permitted with attribution. Its declared scope is the
  non-conceded French national network.
- `us-wzdx-fe9b3423ea03546f`: the concrete Kansas child of `us-wzdx`; its feed metadata
  declared CC0 1.0. Parent and child policy identities are both retained.
- `lu-cita`: CC0 1.0 evidence from the CITA DATEX II v3.6 dataset record.

Other WZDx registry children remain discoveries with unknown rights. They are
listed for diagnosis and are not scheduled or admitted through the aggregate
parent.

The DiaLog `TrafficRegulationPublication` spike is **no-go** for this rollout.
The original endpoint did not provide a current response during repeated checks,
and the existing SituationPublication parser does not establish compatibility
with its access/speed/validity predicate profile. The public dataset's reported
availability is useful context, but is not endpoint or parser evidence. Admission
requires a successful original-endpoint capture, a fixture-backed profile mapping,
and explicit treatment of nested predicates; no fallback parser is enabled.
