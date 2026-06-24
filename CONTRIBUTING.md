# Contributing to OpenConditions

Thanks for your interest in contributing. OpenConditions is an open, federated
**live-conditions data commons** — the dynamic layer (road incidents, roadworks,
closures, hazards, congestion) that complements OpenStreetMap's static map. Its
reference consumer is [OpenMapX](https://openmapx.com), but the data and the
libraries are meant to be reused anywhere.

Have a usage question or an idea to discuss? Please start in
[GitHub Discussions](https://github.com/openconditions/openconditions/discussions)
rather than the issue tracker — see [SUPPORT.md](SUPPORT.md). All participation is
covered by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **New feed sources** — the highest-leverage contribution. A parser + a
  `FeedSource` entry in [`@openconditions/roads`](packages/roads) turns a public
  open-data feed (DATEX II, Open511, GeoJSON, …) into canonical observations.
  Link the open-data portal and its license in your PR.
- **Emitters** — outbound projections to standard wire formats live in
  [`@openconditions/publishers`](packages/publishers) (GeoJSON, TraFF, DATEX II,
  GTFS-RT, JSON-LD, Valhalla exclusions).
- **The canonical model** — the two-axis `Observation` model, severity, and
  freshness helpers live in [`@openconditions/core`](packages/core).
- **The OpenLR resolver** — the Python map-matcher in
  [`services/openlr-resolver`](services/openlr-resolver).
- **The OpenMapX integration** — the provider that exposes observations to
  OpenMapX lives in
  [`integrations/road-conditions-openconditions`](integrations/road-conditions-openconditions).
- **Bug reports / feature requests** — file an issue with reproduction steps and
  your environment (which feeds are configured, the affected component, and the
  version / commit SHA).
- **Documentation** — the README and per-service READMEs welcome improvements.

## Development setup

Requirements:

- Node 24+ (`.nvmrc` is authoritative)
- pnpm 11+ (the version is pinned in `package.json` `packageManager`)
- Docker if you want to run the testcontainers-based suites or PostGIS locally
- Python 3.12+ only if you work on the OpenLR resolver

```bash
pnpm install

# Run the ingest service against a local PostGIS (any reachable PostGIS works):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/openconditions \
  pnpm --filter @openconditions/ingest dev

# Work on the Python resolver:
cd services/openlr-resolver
pip install -r requirements.txt -r requirements-dev.txt
```

## Quality bar

Every PR must pass the same checks CI runs.

TypeScript / Node:

```bash
pnpm lint        # eslint + prettier --check
pnpm typecheck   # tsc across the workspace (turbo)
pnpm test        # Vitest
```

Python (the resolver):

```bash
cd services/openlr-resolver
ruff check .
python -m pytest
```

Git hooks enforce a two-stage local gate (Husky):

- **pre-commit** — fast checks only: `pnpm lint` + `pnpm typecheck`. No Docker
  required.
- **commit-msg** — validates the message against Conventional Commits
  (commitlint).
- **pre-push** — the full test suite (`pnpm test`). The ingest's pipeline/sweep
  suites use testcontainers and need Docker; set `SKIP_TESTCONTAINERS=1` to skip
  them when the daemon isn't running.

CI re-runs lint, typecheck, and the full suite (plus the Python lint/tests) on
every push and PR, so the safety net is always present.

### Testing

Tests run from a single root `vitest.config.ts` (one `node` project covering
`packages/*`, `services/*`, and `integrations/*`). There are no per-package
Vitest configs — always run from the repo root:

```bash
pnpm test                                  # whole suite
pnpm exec vitest run packages/core         # scope by path or test-name substring
pnpm test:coverage                         # V8 coverage report (written to coverage/)
```

Conventions:

- **Co-locate** tests as `*.test.ts` next to the code (or a sibling `__tests__/`).
- **Keep parsers/emitters pure** and test them table-driven against captured
  fixtures — most of `roads` and `publishers` is tested this way.
- **Database-backed suites** (the ingest) spin up a real PostGIS with
  testcontainers; gate them behind Docker and keep them deterministic.

### Code style

- eslint + prettier handle linting and formatting; configuration lives in
  `eslint.config.js` and `.prettierrc.json`. Don't reformat unrelated code in a
  feature PR.
- TypeScript everywhere on the Node side. Avoid `any`; prefer `unknown` plus a
  narrowing type guard at the boundary.
- Don't add divider comments (`// ----` or `// ====`).
- Add a comment only when the _why_ is non-obvious. Don't narrate the _what_ —
  well-named identifiers cover that.

### Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org),
enforced by commitlint via Husky and by the `pr-title` GitHub Action.

```text
feat(roads): add the Open511 parser for the BC feed
fix(ingest): keep last-good rows when the site table fetch fails
docs(readme): document the public emitter feeds
```

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Open an issue first if the change is non-trivial — saves rework when scope or
   approach needs alignment.
3. Push your branch and open a PR. Fill out the PR template.
4. CI runs lint, typecheck, and tests (Node + Python). Iterate until green.
5. A maintainer reviews. Squash-merge is the default; we keep the merged PR's
   title and summary as the squash commit message, so make both accurate.

## Licensing and the CLA

OpenConditions uses a two-license split: the ingest service is
AGPL-3.0-or-later and the reusable libraries (and the OpenMapX integration) are
Apache-2.0. See [LICENSING.md](LICENSING.md) for the full breakdown.

Contributions are accepted under a Contributor License Agreement
([CLA.md](CLA.md)). You keep ownership of your contributions; the CLA grants the
maintainer the rights needed to keep the project sustainable, including offering
a commercial license alongside the AGPL.

You don't sign anything by hand. When you open your first pull request, an
automated assistant comments asking you to confirm you agree to the CLA by
replying:

```text
I have read the CLA Document and I hereby sign the CLA
```

Your agreement is recorded against your GitHub account and applies to future
contributions, so you only confirm once. If you contribute as part of your job,
make sure you're authorized to agree on your own or your employer's behalf.

## Reporting security issues

Please don't file public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## Code of Conduct

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
