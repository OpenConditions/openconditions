# NDW DATEX II v3 flow fixtures

Captured on 16 October 2026 from NDW / Rijkswaterstaat:

- `sites.xml`: <https://opendata.ndw.nu/snelheden_en_intensiteiten_configuratie_meetlocaties.xml.gz>
- `measurements.xml`: <https://opendata.ndw.nu/snelheden_en_intensiteiten_meetgegevens.xml.gz>

Licence: CC0 1.0, as declared by the existing `nl-ndw-flow` catalogue entry;
[NDW reuse information](https://www.ndw.nu/service/copyright).

Two whole station records are retained: `GAD02_Amstd_31_0` (24 speed/volume
channels, length bands, all-vehicle channels, zero-input no-data speeds) and
`RWS01_MONIBAS_0010vwa0108ra` (four all-vehicle channels, speeds without input
counts). Headers and station revisions are retained. Other station records are
removed; namespace prefixes and whitespace were normalized with ElementTree.
No measurement values or metadata were changed. The absence of lane assignments
is present in the original v3 table.

See [migration evidence](../../../../../../docs/ndw-flow-migration.md) for full
capture hashes, counts, provider differences and the limits of qualification.
