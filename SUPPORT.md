# Getting help

Thanks for using OpenConditions! This page explains where to go for what.
OpenConditions is maintained by volunteers — please pick the right channel so
questions reach the right place and nothing gets lost.

## Documentation first

Most answers live in the repository:

- **[README](README.md)** — what OpenConditions is, the architecture, and how to
  run it.
- **[Services](services/)** — the [`ingest`](services/ingest) service (feeds →
  PostGIS + public emitter feeds) and the [`openlr-resolver`](services/openlr-resolver).
- **[Packages](packages/)** — the reusable `@openconditions/*` libraries (the
  canonical model, parsers, and emitters).
- **Using OpenConditions with OpenMapX** — install it as an extension via the ingest
  service's [`service.json`](services/ingest/service.json) manifest and the
  [`road-conditions-openconditions`](integrations/road-conditions-openconditions)
  provider integration; see OpenMapX's _Building an external extension_ guide for
  the end-to-end install flow.

## Questions, ideas, and discussion

For usage questions ("how do I…?"), configuration help, new-feed ideas, and
general discussion, use
**[GitHub Discussions](https://github.com/openconditions/openconditions/discussions)**.

Please don't open an issue for a question — issues are reserved for confirmed
bugs and actionable feature requests.

## Bug reports and feature requests

Use the **[issue tracker](https://github.com/openconditions/openconditions/issues/new/choose)**
and pick the appropriate template:

- **Bug report** — include reproduction steps and your environment (which feeds
  are configured, the affected service, and the version / commit SHA).
- **Feature request** — describe the use case. A new feed source? Link the open
  data portal and its license.

Before filing, please search existing issues and discussions to avoid duplicates.

## Security issues

**Do not** report security vulnerabilities in public issues or discussions. See
**[SECURITY.md](SECURITY.md)** for the private disclosure process.

## Contributing

Want to fix or build something yourself? See **[CONTRIBUTING.md](CONTRIBUTING.md)**
for development setup, the quality bar, and the pull-request workflow.

## Scope of support

OpenConditions is provided under open-source licenses with **no warranty or
guaranteed support** (see [LICENSING.md](LICENSING.md)). Community help is
best-effort. If you need commercial support or a license for proprietary use,
contact the maintainer.
