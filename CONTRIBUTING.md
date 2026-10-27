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
  open-data feed (DATEX II, Open511, GeoJSON, …) into situation drafts of the
  [data model](docs/model.md). Link the open-data portal and its license in
  your PR.
- **Emitters** — outbound projections to standard wire formats live in
  [`@openconditions/publishers`](packages/publishers) (GeoJSON, JSON-LD, TraFF,
  DATEX II, SSE, Valhalla exclusions).
- **The data model** — record classes and the registry live in
  [`@openconditions/model`](packages/model) and its domain modules (roads:
  [`@openconditions/model-roads`](packages/model-roads)); read helpers and the
  database schema in [`@openconditions/core`](packages/core).
- **The OpenLR resolver** — the Python map-matcher in
  [`services/openlr-resolver`](services/openlr-resolver).
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
python scripts/check_dependencies.py
python -m pip install --require-hashes --only-binary=:all: -r requirements-build.txt
python -m pip install --require-hashes --no-build-isolation -r requirements-dev.txt
```

## Quality bar

Every PR must pass the same checks CI runs.

TypeScript / Node:

```bash
pnpm lint        # Biome + the import-boundary gate
pnpm typecheck   # tsc across the workspace (turbo)
pnpm check-credentials
pnpm check:model
pnpm check:feed-schemas
pnpm feeds:lint
pnpm check:ci    # CI outcome and main reconciliation command fixtures
pnpm test        # build workspace dependencies, then all Vitest projects
pnpm verify:full # new explicit command: all deterministic Node checks above
```

`verify:full` includes lint/import boundaries, workspace and script types, generated credentials,
model artifacts, feed schemas, feed lint and the full Node suite. It needs Docker/PostGIS for database
tests. For the same OpenLR cross-check as CI, install the hash-pinned
`packages/openlr/python/requirements.txt` into your Python environment, put it on `PATH` and set
`OPENLR_CROSSCHECK=required`. This command does not run the separate resolver checks, independent
interop or dependency audits below, or prove live provider/deployment behavior. For a docs-only change,
use scoped Prettier checks; for Node behavior, run focused tests while iterating and `verify:full` before
review. Resolver, wire-format/federation and dependency changes also need their corresponding checks
below. CI retains every applicable gate on every PR.

Python (the resolver):

```bash
cd services/openlr-resolver
ruff check .
OPENLR_POSTGIS_TESTS=required python -m pytest
```

This matches CI and requires Docker plus the resolver's locked development dependencies.
PostGIS tests use their own disposable PostgreSQL 16 server, never an operator database.
Local `python -m pytest` defaults to optional database availability; missing Docker or
Testcontainers skips the database cases. Required mode fails if those cases are skipped
or omitted. Use optional mode for focused non-database tests; unknown mode values fail.

Independent implementations (CI's `interop` job; JDK 17+, Python 3.14 and network
access, after `pnpm build`):

```bash
bash scripts/traff-interop/check.sh # TraFF feeds through the pinned libtraff reader
bash scripts/tuf-interop/check.sh   # registry TUF repositories through python-tuf, both ways
```

Production dependency audits (after installing both sets of development dependencies):

```bash
pnpm audit:production # pnpm audit + pip-audit, with zero findings required
```

Git hooks check staged work (Husky):

- **pre-commit** — `node scripts/check-staged.mjs` checks staged TS/JS/JSON/JSONC with Biome and
  Markdown/YAML with Prettier, using staged configuration and existing ignore rules. Feed JSONC keeps
  its trailing-comma override; Python remains owned by its own tooling. Empty commits do not start
  pnpm or resolve formatters. Only locally installed tools run; missing tools fail with an explicit
  install instruction. No hook downloads dependencies.
- **commit-msg** — validates the message against Conventional Commits
  (commitlint).
- **pre-push** — no automatic workspace checks, builds, tests or Docker. Run the appropriate explicit
  commands before review; CI enforces the full checks. No shared push lock is used.

The staged helper reads an isolated index snapshot and never formats source files or updates the
index. Partially staged files are checked as they would be committed, even when the working copy is
different. If a check fails, format/fix the working file, inspect the diff and stage only the intended
hunks (`git add -p`). An index or HEAD change during checking fails and requires a retry; concurrent
changes are preserved. Added/renamed regular files are checked; deleted files, symlinks and files
owned by other tooling are not followed or checked. Run `pnpm check:staged` to repeat the hook manually.

CI re-runs lint, typecheck, the full suite, the Python lint/tests, and both
production dependency audits on every push and PR. The audits also run weekly
so newly published advisories fail without waiting for a source change.

### Main validation and required checks

CI reports `required CI` after checking every applicable outcome: source
validation, TypeScript, Python, independent interop and production audits. A
failed, cancelled, missing or unexpectedly skipped job fails the aggregate.
The weekly CI schedule intentionally runs only the production audit and source
validation; its skipped ordinary jobs are allowed only on that event.

`full main qualification` additionally requires successful execution of all
coverage and the aggregate on an exact main push or main manual dispatch. A
successful weekly audit or PR run cannot qualify main.

`Reconcile main validation` checks current main after CI/Dependabot completion
and at minutes 17 and 47 each hour. It runs trusted default-branch code without
installing dependencies or reading PR artifacts. The Actions token can dispatch
CI, with an independently read `expected_main_sha`; CI rejects a stale SHA
before installing dependencies. Native Dependabot auto-merge is unchanged.

The dispatcher deduplicates pending full runs and successful, fully qualified
run attempts. It permits one automatic recovery per SHA, identified by the
reserved `Main validation recovery <sha>` run title; ambiguous or missing actor
metadata still consumes that budget. A failed recovery stays visibly red: inspect its exact run and attempt, repair the cause,
and use **Actions → CI → Run workflow**, select **main**, and leave
`expected_main_sha` empty for an explicit maintainer retry. A failed or ambiguous
dispatch request is not retried in the same invocation; the next backstop reads
retained runs before deciding. API reads have at most three transient retries
within a 60-second request budget. No new credentials are required.

Run history can expire under GitHub's [retention policy](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization).
To keep expiration from resetting the recovery budget, automatic dispatch is
limited to the first 23 hours after a verified GitHub-created commit (the
`web-flow` committer). The immutable signed commit time anchors this window;
new runs, triggers and schedules cannot extend it. Older, unsigned, non-GitHub
or unverifiable commits fail closed and require the explicit main dispatch
above. Retained successful full qualification and already pending full runs
remain valid independently of that automatic-dispatch cutoff. This limits
recovery availability when scheduling is delayed; it does not relax any gate.

The backstop validates the current main commit, so intermediate auto-merges can
be coalesced. Its recovery target is the next nominal half-hour interval plus
GitHub queue/run time, not a wall-clock guarantee. Only exact commits with the
full marker are qualified. Source fixtures, PR CI, and actual post-merge bot-path
qualification are separate evidence. Required-check settings are migrated only
after the new producers have real successful PR evidence; keep existing check
coverage until that migration is read back.

### Testing

Tests run from one root `vitest.config.ts`, with `unit` and `integration`
projects covering packages, services, integrations, and scripts. The
integration project runs after the unit project, two files at a time, against
one PostGIS container its global setup starts and migrates as a template
(`OC_TEST_POSTGIS_PROFILE=pg16|pg18` picks the server, PG16 by default). Run
from the repo root:

```bash
pnpm test                                  # build, then both projects
pnpm test:unit                             # build, then tests without Docker
pnpm test:integration                      # build, then disposable database tests
pnpm exec vitest run --project unit packages/core # targeted run after building
pnpm test:coverage                         # V8 coverage report (written to coverage/)
```

Conventions:

- **Co-locate** tests as `*.test.ts` next to the code (or a sibling `__tests__/`).
- **Keep parsers/emitters pure** and test them table-driven against captured
  fixtures — most of `roads` and `publishers` is tested this way.
- **Database-backed suites** use `*.integration.test.ts` and take a fresh
  database cloned from the migrated template with `createTestDatabase()` from
  `@openconditions/test-database`; keep them deterministic and independently
  seeded. Only suites that observe the server as a whole (its version and WAL,
  or the transaction horizon the federation outbox fence reads) start a
  container of their own.
- The scripts build dependencies first because workspace exports resolve to
  `dist`. Direct `vitest` invocations assume an up-to-date build. Unit runs use
  four workers and integration runs two; use `--maxWorkers` to adjust for the
  available memory.

### Code style

- Biome handles formatting and linting; configuration lives in `biome.json`.
  `pnpm format` writes formatting; `pnpm exec biome check --write .` also
  applies safe lint fixes and sorts imports. Don't reformat unrelated code in a
  feature PR.
- Biome cannot parse Markdown or YAML, so Prettier owns exactly those
  extensions and nothing else. One tool per file type, so the two never format
  the same file. The feed catalogue (`feeds/**/*.jsonc`) is JSONC, formatted by
  Biome with trailing commas, and is additionally checked by `pnpm feeds:lint`;
  `pnpm feeds:check <file…>` fetches and parses the feeds of region files live.
  See [`feeds/README.md`](feeds/README.md).
- Two recommended rules are relaxed, both for reasons specific to this
  codebase: `useLiteralKeys` is off because untyped source payloads are read
  through index access on purpose, and `noNonNullAssertion` is off in tests,
  where asserting on a known fixture value is the point.
- Architecture import boundaries live in `scripts/check-import-boundaries.ts`
  rather than in the linter, because Biome has no `no-restricted-syntax`
  equivalent. `scripts/__tests__/architecture-guards.test.ts` is their
  specification.
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

## Repository protection

Changes to `main` go through a pull request and the required checks. Independent human approval is optional; all review conversations must be resolved. Merge with squash using the PR title and body. Required checks use loose freshness, with no merge queue. Keep the PR title conventional and its description useful as the resulting commit message.

The [repository guardrails runbook](docs/repository-guardrails.md) lists the required check producers, Actions protections and the maintainer-only emergency process. An agent never has standing authority to bypass checks or push directly to `main`. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

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
AGPL-3.0-or-later, as is the shared persistence projection in `packages/storage`.
Other reusable libraries (and the OpenMapX integration) are Apache-2.0, except
for the explicitly isolated AGPL probe spike. See [LICENSING.md](LICENSING.md) for the full breakdown.

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
