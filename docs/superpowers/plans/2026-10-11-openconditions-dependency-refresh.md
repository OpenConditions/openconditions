# OpenConditions Dependency and Upstream Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every OpenConditions-controlled package, Python dependency, toolchain, Action, image, and generated upstream artifact to the newest supportable stable release while preserving producer contracts consumed by OpenMapX.

**Architecture:** Refresh JavaScript, Python, CI, and container dependency classes in separate green commits, proving breaking migrations with focused tests and regenerating each lock through its owning tool. Verify the producer model and wire contracts before OpenMapX consumes the resulting commit.

**Tech Stack:** pnpm workspaces, Node.js, TypeScript, Vitest, Turbo, Python/pip-tools, Ruff, pytest, Docker Buildx, Trivy, GitHub Actions, generated feed/model/atlas artifacts.

**Spec:** `docs/superpowers/specs/2026-10-11-cross-repository-dependency-refresh-design.md`

## Global Constraints

- Target the newest stable release, including majors, unless current authoritative compatibility evidence proves it unsupported.
- Exclude prereleases unless OpenConditions already depends on that release line or a supported platform requires it.
- Preserve full-SHA Action pins, immutable multi-architecture image digests, Python hashes, reproducible pnpm locks, and pnpm supply-chain policy.
- Do not add vulnerability exceptions, warning-only bypasses, permanently red checks, or floating pins.
- Do not change producer API/model/data semantics, licensing, rights metadata, authentication, privacy behavior, or supported platforms without returning to the user.
- Do not read complete environment files or secret values and do not mutate production systems or live feed state.
- Keep generated files with their owning generator and inspect their diffs.
- Commit each green dependency class separately; retain the last green class if a stop condition is reached.

## Review Focus

- A package upgrade must not weaken pnpm install-script, provenance, release-age, patch, or override policy; Task 2 runs frozen installs and architecture gates.
- The `postgres` patch must be removed only if upstream behavior and the owning regression prove it obsolete, otherwise it must be rebased exactly; Task 2 owns that test.
- Python locks must be regenerated with hashes for the declared Python support range and must not diverge from `pyproject.toml`; Task 3 checks both runtime and development environments.
- An image refresh must retain non-root/runtime hardening and immutable architecture-correct digests; Task 5 builds and scans all three production services.
- Producer source/rights/pagination/completeness/authentication contracts must remain consumable by OpenMapX; Task 7 runs producer and consumer-facing contract tests.

---

### Task 1: Refresh the authenticated base and establish the execution baseline

**Files:**
- Preserve: `docs/superpowers/specs/2026-10-11-cross-repository-dependency-refresh-design.md`
- Preserve: `docs/superpowers/plans/2026-10-11-openconditions-dependency-refresh.md`

**Interfaces:**
- Consumes: authenticated `OpenConditions/openconditions` `main` and the existing green local baseline.
- Produces: a current branch with exact base SHA and recorded pre-upgrade warnings/failures.

- [ ] **Step 1: Refresh `origin/main` through authenticated HTTPS and rebase the specification and plan commits**

Run: `git fetch https://github.com/OpenConditions/openconditions.git main:refs/remotes/origin/main && git rebase origin/main`

Expected: fetch and rebase succeed without reading or printing credentials.

- [ ] **Step 2: Record the base and rerun the unchanged baseline gates**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`

Run in `services/openlr-resolver`: `.venv/bin/ruff check . && .venv/bin/python -m pytest`

Expected: the known warning-only baseline remains distinct from failures; all required commands pass before upgrades.

### Task 2: Refresh the pnpm workspace and re-evaluate the committed patch

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify as selected by pnpm: `packages/*/package.json`, `services/*/package.json`
- Modify or delete: `patches/postgres@3.4.9.patch` and matching `patchedDependencies` entry.
- Test: focused tests adjacent to every source migration required by a breaking package release.

**Interfaces:**
- Consumes: current npm registry metadata, package release notes, workspace relationships, and the existing patched `postgres` behavior.
- Produces: a frozen-installable workspace at newest supportable stable releases with only necessary overrides and patches.

- [ ] **Step 1: Capture package candidates and production advisories**

Run: `pnpm outdated --recursive --format json` and `pnpm audit --prod --json`

Expected: machine-readable candidate and advisory sets are recorded; advisory exit `1` is parsed rather than ignored.

- [ ] **Step 2: Upgrade direct dependencies to latest stable releases and regenerate `pnpm-lock.yaml`**

Run: `pnpm update --recursive --latest`

Expected: every direct dependency moves unless an authoritative incompatibility is documented.

- [ ] **Step 3: For each major family, write a focused failing regression for observed changed behavior before applying the documented source migration**

Families include Fastify, Postgres/Drizzle, Zod, model/serialization libraries, Vitest/Vite/Tsup/Turbo, Biome/TypeScript, and service runtime dependencies.

- [ ] **Step 4: Test the behavior protected by `patches/postgres@3.4.9.patch` against the upgraded unpatched release**

Expected: remove the patch only when the owning regression passes unpatched; otherwise rebase it to the selected version and prove the patched test fails before and passes after application.

- [ ] **Step 5: Re-evaluate overrides, trust exclusions, install-build entries, and peer decisions**

Expected: obsolete entries are removed; retained entries have current evidence; supply-chain policy is not weakened.

- [ ] **Step 6: Verify the JavaScript workspace**

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm typecheck && pnpm test`

Expected: all 32 workspace projects build and all unit/integration suites pass.

- [ ] **Step 7: Commit the package refresh**

Run: `git add package.json pnpm-workspace.yaml pnpm-lock.yaml packages services patches && git commit -m "chore(deps): refresh workspace dependencies"`

### Task 3: Refresh Python and resolver tooling

**Files:**
- Modify: `services/openlr-resolver/pyproject.toml`
- Modify: `services/openlr-resolver/requirements.in`
- Modify: `services/openlr-resolver/requirements-dev.in`
- Regenerate: `services/openlr-resolver/requirements.txt`
- Regenerate: `services/openlr-resolver/requirements-dev.txt`
- Modify when required by breaking releases: `services/openlr-resolver/app/**`
- Test: `services/openlr-resolver/tests/**`

**Interfaces:**
- Consumes: current PyPI stable metadata, Python compatibility classifiers, pip-tools, and hash-lock generation under the supported Python line.
- Produces: synchronized project/runtime/dev declarations with complete hashes and a passing resolver service.

- [ ] **Step 1: Compare all direct Python pins with current stable PyPI releases and inspect their migration notes**

Expected: FastAPI/Starlette/Pydantic, Uvicorn, OpenLR libraries, geometry/database libraries, pytest/httpx, Ruff, pip-tools, and transitive security fixes are covered.

- [ ] **Step 2: Update direct declarations in `pyproject.toml` and both input files**

Expected: runtime and development inputs agree with project metadata.

- [ ] **Step 3: Regenerate both hash locks with the repository's documented pip-compile command and selected supported Python**

Run in `services/openlr-resolver`: `pip-compile --upgrade --generate-hashes --output-file=requirements.txt requirements.in` and `pip-compile --upgrade --generate-hashes --output-file=requirements-dev.txt requirements-dev.in`

Expected: generated headers record the actual interpreter/tool, and every locked artifact has hashes.

- [ ] **Step 4: For each breaking runtime change, add a focused failing pytest before applying the minimum migration**

Expected: request/response validation, map matching, database access, and application lifecycle behavior remain explicit.

- [ ] **Step 5: Verify clean isolated runtime and dev installations**

Run: `python -m pip install --require-hashes -r requirements.txt` and `python -m pip install --require-hashes -r requirements-dev.txt` in disposable virtual environments, then `ruff check . && python -m pytest`.

Expected: both lock installations and all resolver tests pass.

- [ ] **Step 6: Run a Python vulnerability audit without an exception file**

Run: `pip-audit --requirement requirements.txt` and `pip-audit --requirement requirements-dev.txt`

Expected: zero known vulnerabilities or the plan stops with exact dependency paths and upstream fix status.

- [ ] **Step 7: Commit the Python refresh**

Run: `git add services/openlr-resolver && git commit -m "chore(deps): refresh resolver dependencies"`

### Task 4: Refresh language toolchains and GitHub Actions

**Files:**
- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `.github/workflows/*.yml`
- Modify when workflow expectations change: `scripts/__tests__/**`

**Interfaces:**
- Consumes: official Node/pnpm/Python support data and official Action releases with immutable commit SHAs.
- Produces: consistent runtime pins and newest stable Actions with least-privilege permissions.

- [ ] **Step 1: Resolve newest stable supported Node, pnpm, and Python lines and update every duplicate declaration**

Expected: `.nvmrc`, engine/package-manager fields, workflow setup values, and Docker bases agree.

- [ ] **Step 2: Inventory each external `uses:` reference and resolve the newest stable release commit through the official upstream repository**

Expected: every remote Action is pinned to a 40-character SHA with an accurate version comment.

- [ ] **Step 3: Update one Action family at a time and migrate changed inputs/permissions**

Expected: permissions remain least privilege and local reusable workflows remain local.

- [ ] **Step 4: Verify toolchain, workflow, generated-artifact, and architecture contracts**

Run: `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit scripts`

Expected: all checks pass.

- [ ] **Step 5: Commit toolchain and Action updates**

Run: `git add .nvmrc package.json .github/workflows scripts && git commit -m "chore(ci): refresh toolchains and pinned actions"`

### Task 5: Refresh production images

**Files:**
- Modify: `services/contributions-api/Dockerfile`
- Modify: `services/ingest/Dockerfile`
- Modify: `services/openlr-resolver/Dockerfile`
- Modify: `services/contributions-api/service.json`
- Modify: `services/ingest/service.json`
- Modify duplicated workflow image/build inputs: `.github/workflows/release.yml`, `.github/workflows/ci.yml`
- Test: Docker/service contract tests and service smoke tests.

**Interfaces:**
- Consumes: official stable base-image tags, immutable multi-architecture digests, and runtime compatibility notes.
- Produces: buildable, non-root hardened production images pinned immutably and scanned without suppressions.

- [ ] **Step 1: Resolve the newest supportable stable tags and immutable multi-arch digests for every Dockerfile stage and declared service image**

Run `docker buildx imagetools inspect` for each candidate.

Expected: architecture coverage is no narrower than before and Node/Python toolchains match Task 4.

- [ ] **Step 2: Update Dockerfiles, service manifests, and workflow references together**

Expected: image/tag/digest triples match and hardening such as non-root users and minimal runtime stages remains intact.

- [ ] **Step 3: Build all three production targets and run their health/smoke tests**

Expected: contributions API, ingest, and OpenLR resolver images build and start sufficiently to execute their deterministic health paths.

- [ ] **Step 4: Scan each built filesystem with the repository's Trivy policy**

Expected: no finding is suppressed; an unfixed actionable advisory triggers the spec's stop condition.

- [ ] **Step 5: Commit the image refresh**

Run: `git add services .github/workflows && git commit -m "chore(containers): refresh pinned images"`

### Task 6: Refresh and validate generated upstream artifacts

**Files:**
- Regenerate as applicable: `feeds/**`, model artifacts, feed schemas, credentials inventory, and exported atlas files.
- Modify generators only for a demonstrated upstream format migration: `scripts/gen-*.ts`, `scripts/export-atlas.ts`, `scripts/feeds-*.ts`.
- Test: `scripts/__tests__/export-atlas.test.ts`, `scripts/__tests__/feeds-check.test.ts`, `scripts/__tests__/feeds-lint.test.ts`, model registry tests, and source parser tests.

**Interfaces:**
- Consumes: repository-controlled feed/catalog revisions, current source metadata, and generator outputs.
- Produces: generator-clean artifacts whose rights/source/schema meaning is unchanged or explicitly stopped for decision.

- [ ] **Step 1: Inventory versioned upstream/feed references and run all owning generators in check mode**

Run: `pnpm check-credentials && pnpm check:feed-schemas && pnpm check:model && pnpm feeds:lint`

Expected: the pre-refresh generator state is known and reproducible.

- [ ] **Step 2: Refresh controlled upstream revisions and regenerate artifacts through owning commands**

Run: `pnpm gen:credentials && pnpm gen:feed-schemas && pnpm gen:model && pnpm export:atlas` as applicable to changed inputs.

Expected: no generated file is hand-edited.

- [ ] **Step 3: Inspect source, rights, attribution, schema, provider meaning, geography, and representative data diffs**

Expected: mechanical revisions proceed; any policy or rights change triggers the spec's stop condition.

- [ ] **Step 4: Verify feeds and generated artifacts**

Run: `pnpm check-credentials && pnpm check:feed-schemas && pnpm check:model && pnpm feeds:lint && pnpm exec vitest run --project unit scripts packages/model-registry`

Expected: all deterministic checks pass. Live `feeds:check` coverage is recorded separately because external feed outages are not source regressions.

- [ ] **Step 5: Commit changed upstream artifacts**

Run: `git add feeds scripts packages && git commit -m "chore(upstreams): refresh generated catalogs"`

Skip this commit when the authoritative inventory proves no controlled revision is outdated.

### Task 7: Enforce clean audits and verify producer contracts

**Files:**
- Create only if JavaScript and Python audits are clean: `scripts/check-production-audits.ts`
- Create only if JavaScript and Python audits are clean: `scripts/__tests__/check-production-audits.test.ts`
- Modify only if audits are clean: `package.json`, `.github/workflows/ci.yml`.
- Modify only for demonstrated producer regressions: adjacent model, service, or contract tests/source.

**Interfaces:**
- Consumes: clean JavaScript and Python audits plus the final producer implementation.
- Produces: fail-closed zero-advisory automation and a producer commit ready for OpenMapX consumer verification.

- [ ] **Step 1: Run final JavaScript and Python production audits**

Run: `pnpm audit --prod --json`; in `services/openlr-resolver`, run `pip-audit --requirement requirements.txt`.

Expected: zero advisories. Otherwise stop with exact dependency path, reachability, upstream status, and choices; do not add an exception.

- [ ] **Step 2: Add failing tests for clean success, any advisory, malformed scanner output, and subprocess failure**

Expected: tests fail before the strict checker exists and define no exception interface.

- [ ] **Step 3: Implement the minimal required/scheduled zero-advisory gate and make the tests pass**

Expected: the gate accepts only well-formed zero-advisory results and emits bounded metadata.

- [ ] **Step 4: Verify producer model, source, rights, pagination, completeness, and authentication contracts**

Run the owning unit and integration suites plus generated model/schema checks.

Expected: every contract OpenMapX consumes passes against deterministic fixtures or a local reproducible environment.

- [ ] **Step 5: Run final repository verification**

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm check-credentials && pnpm check:feed-schemas && pnpm check:model && pnpm feeds:lint && git diff --check`

Run in `services/openlr-resolver`: isolated hash-locked install, `ruff check .`, and `python -m pytest`.

Also run all container builds/scans changed by Task 5.

Expected: every locally available required check passes; any unavailable external/native check is named exactly.

- [ ] **Step 6: Review commits and branch scope**

Run: `git log --oneline origin/main..HEAD && git diff --stat origin/main...HEAD && git diff --check origin/main...HEAD`

Expected: logically ordered commits, no unrelated changes, and a clean diff.

- [ ] **Step 7: Push and open the OpenConditions pull request**

Assign `Medformatik`, apply appropriate existing labels, read both back, link the PR to the working thread, and wait for remote CI. Do not merge or deploy.
