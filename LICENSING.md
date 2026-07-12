# Licensing

OpenConditions uses a deliberate two-license split: the **network service** is
strong copyleft, and the **reusable libraries** are permissive so that other
projects can adopt them freely.

| What                                                                                                                                                                                                                                           | License               | Why                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ingest service — the deployable network commons server (`services/ingest`)                                                                                                                                                                 | **AGPL-3.0-or-later** | Keeps OpenConditions and any hosted derivative open. Anyone who runs a modified version as a network service must offer its source.                                                                                   |
| The contributions service — crowd report intake and evidence-state recompute (`services/contributions-api`)                                                                                                                                    | **AGPL-3.0-or-later** | Same rationale as the ingest service: a deployable network server whose hosted derivatives must stay open.                                                                                                            |
| Reusable libraries (`packages/*`: `@openconditions/core`, `roads`, `publishers`, `openlr`), the OpenMapX provider integration (`integrations/road-conditions-openconditions`), and the standalone OpenLR resolver (`services/openlr-resolver`) | **Apache-2.0**        | These have value outside OpenConditions — the canonical model, the parsers/emitters, and a generic OpenLR map-matcher. A permissive license (with an explicit patent grant) lets any project depend on or embed them. |
| Vendored third-party code                                                                                                                                                                                                                      | Its upstream license  | Not ours to relicense.                                                                                                                                                                                                |

The root [`LICENSE`](LICENSE) file is the AGPL-3.0 and governs the repository by
default. Packages that carry a different license have their own `LICENSE` file
and a matching `license` field in their `package.json` (or `pyproject.toml`);
that per-package license takes precedence for that package.

The third-party Docker images OpenConditions runs alongside (PostGIS, and — when
self-hosting OpenMapX — Valhalla, Redis, …) run as **separate containers
communicating over the network**. They are not linked into OpenConditions' code
and keep their own upstream licenses; they impose no obligation on the license of
OpenConditions' own source.

Apache-2.0 is one-directionally compatible with the AGPL: the AGPL service may
include the Apache-2.0 libraries, but not the other way around. That is why the
shared libraries — the parts we want others to reuse — are the permissive ones,
and the service that ties them together into a hosted commons is copyleft.

## Source-data licensing

OpenConditions aggregates road-condition data from public feeds, each under its
own license — for example NDW (CC0-1.0), Die Autobahn GmbH (dl-de/by-2.0),
Fintraffic / Digitraffic (CC-BY-4.0), DriveBC (OGL-BC), and the WZDx feeds
(mixed, per publishing agency). **This data is not ours and is not relicensed**:
every observation carries its `source` and `source_license`, and consumers must
honour the originating license and attribution.

Where data is derived from OpenStreetMap (e.g. the OSM road graph the OpenLR
resolver builds), the **ODbL** governs that derived data, including its
share-alike obligation. The publishing emitters
([`@openconditions/publishers`](packages/publishers)) carry a per-record license
filter so share-alike-incompatible records can be excluded from permissive
exports — produced feeds must not silently launder a stricter source license
into a looser one.

## Contributing and relicensing

Contributions are accepted under a Contributor License Agreement
([`CLA.md`](CLA.md)). The CLA lets You keep ownership of Your contributions
while granting the maintainer the right to license the combined work under other
terms — for example, a commercial license alongside the AGPL. This preserves the
Project's ability to sustain itself without changing the open-source promise to
the community. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how signing works.
