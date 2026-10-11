# Cross-repository dependency and upstream refresh

## Outcome

Bring every repository-controlled dependency and upstream revision in OpenMapX
and OpenConditions to the newest stable version that can be supported without
weakening either project's product, platform, licensing, or security contracts.
Apply documented breaking-change migrations, regenerate reproducibility
artifacts, verify the two repositories independently and together, and report
any intentionally retained constraint with current evidence.

This design replaces the narrower scope of OpenMapX Plan 083. Work is delivered
through one isolated branch and pull request per repository. The two pull
requests form one coordinated change, but neither depends on an unmerged commit
from the other. Do not merge or deploy without separate authorization.

## Scope and definitions

A dependency or upstream revision is in scope when either repository controls
its version, commit, digest, checksum, generated lock, or compatibility range.
This includes:

- every JavaScript/TypeScript package manifest and pnpm lockfile, including
  OpenMapX's separate documentation workspace;
- OpenConditions' Python manifests and hash-locked requirement sets;
- GitHub Actions and reusable workflow dependencies;
- Dockerfile base images and service-manifest images;
- Node, pnpm, Python, Expo/React Native, Android, Go, and other build or runtime
  toolchains represented in repository files;
- downloaded binaries, source builds, and other software artifacts such as
  MOTIS and `gtfsclean`;
- external catalog and data revisions, including Transitous, GBFS,
  transport-API, feed/catalog snapshots, and their generated lock files; and
- duplicated version declarations, checksums, schemas, and generated artifacts
  that must move with any item above.

"Newest stable" excludes alpha, beta, release-candidate, nightly, and arbitrary
upstream-head versions unless a repository already relies on that release line
or a supported platform explicitly requires it. Prefer official registries,
release metadata, and upstream repositories over secondary version sources.

The absolute newest release is the first target, including major releases. A
release is incompatible only when current evidence shows that it conflicts with
a supported platform, an upstream compatibility matrix, a public contract, or a
deliberate product requirement after reasonable migration work. Ordinary source
changes required by release notes are part of this project. Convenience or the
size of a migration is not, by itself, evidence of incompatibility.

Unversioned operating-system packages installed from a base distribution are
refreshed through the new immutable base image and validated in the rebuilt
image. Do not invent volatile package pins that the distribution does not
support reproducibly.

## Supply-chain and product invariants

All existing integrity properties remain or become stricter:

- GitHub Actions remain pinned to full commit SHAs with accurate release
  comments.
- Container images remain pinned to immutable multi-architecture digests.
- Downloaded artifacts retain reviewed cryptographic checksums.
- Python requirements remain hash locked.
- Catalog and data locks remain reproducible and identify their upstream
  revision.
- Existing pnpm install-script, provenance, release-age, patch, and trust
  policies are preserved unless a reviewed replacement is stricter.
- Generated files are produced by their owning generator and inspected, never
  hand-edited merely to satisfy a freshness check.
- Source attribution, licensing metadata, privacy disclosures, provider policy,
  and credential boundaries must continue to describe the data actually used.

Do not read complete environment files or secret values. Presence-only checks
may be used when a verification path needs to know whether optional credentials
are configured. No production system, live feed state, registry tag, or deployed
service is mutated by this project.

## Worktree and delivery topology

OpenMapX continues in its existing `fix/security-hardening-all` worktree.
OpenConditions uses the isolated `chore/dependency-refresh-all` worktree. Refresh
both remote bases through an authenticated channel before implementation and
reconcile upstream changes without discarding unrelated work.

Create separate, logically ordered commits for each dependency class in each
repository. Keep generated lock changes with the manifest or pin that produced
them. The expected commit groups are:

1. package ecosystems;
2. language and platform toolchains;
3. GitHub Actions;
4. container base and service images;
5. downloaded software and build artifacts;
6. external catalogs and data revisions; and
7. audit-policy or verification automation that is justified by the final
   state.

The final delivery is one OpenMapX PR and one OpenConditions PR. Assign both to
`Medformatik`, apply appropriate existing labels, read back labels and assignee,
and link both PRs to the working thread. Remote CI must complete before either
change is described as finished.

## Execution phases

### 1. Establish current baselines

Refresh upstream refs, record exact base commits, and confirm clean worktrees
apart from the known staged OpenMapX audit-policy prototype. Inventory current
and available stable versions from authoritative sources. Capture outdated and
vulnerability reports without exposing exploit payloads, credentials, or raw
secret-scanner findings.

Run each repository's unchanged quality gates before upgrades. Existing warnings
must be recorded separately from failures so later tool upgrades cannot hide a
new regression inside the old baseline.

### 2. Refresh package ecosystems

Upgrade direct dependencies before using constraints or overrides. Process
major families separately, read their migration guides, make the minimum
required source migration, and run focused tests before continuing. Regenerate
each pnpm lockfile from its owning workspace. For OpenConditions, regenerate
Python requirement locks with their existing compiler and hashes.

Use an override only when a direct or parent upgrade cannot select the patched
release and the selected version is inside the parent's supported API range.
Never force a major version through an incompatible parent declaration merely to
make an audit disappear. Re-evaluate committed dependency patches against the
new upstream source; rebase a still-needed patch or remove it when upstream has
absorbed the change.

### 3. Refresh toolchains and Actions

Update language runtimes, package managers, mobile/native toolchains, and build
tools to the newest supported stable lines. Respect evidence-backed matrices
such as Expo/React Native and Android compatibility. When the latest platform
line is supportable, perform its documented migration and regenerate native
verification artifacts.

Resolve every GitHub Action's latest stable release to its full commit SHA.
Review release notes and permission changes, retain least-privilege workflow
permissions, and run the repository's workflow-policy checks. A floating action
tag is not acceptable.

### 4. Refresh containers and services

Resolve current stable tags and immutable digests for every Dockerfile base and
service-manifest image. Preserve deliberate compatibility lines only with
documented evidence; when a newer major is supportable, migrate the surrounding
configuration and data contract. Rebuild every affected production target and
scan the produced filesystem rather than inferring safety from a tag or digest.

Container vulnerability results are evidence, not version-selection shortcuts.
Do not suppress or allowlist a finding as part of this refresh. Durable scanning
of every third-party service image remains the separate continuous-control work
defined by OpenMapX Plan 080; this project supplies a fresh verified image
baseline for it.

### 5. Refresh software artifacts and external catalogs

Update pinned binaries, source commits, checksums, and catalog/data revisions
from their authoritative upstreams. Inspect changelogs, schema differences,
license or rights changes, generated inventories, and representative data
diffs. Regenerate owning locks and schemas and run their focused validation.

An update that changes product policy, data rights, attribution duties, provider
meaning, supported geography, or public API semantics is not an automatic
dependency migration. Stop and request a separate decision with the before/after
contract and available alternatives.

### 6. Verify cross-repository compatibility

Treat OpenConditions as the producer and OpenMapX as the consumer. Verify
OpenConditions' model, source, rights, pagination, completeness, and
authentication contracts first. Then run OpenMapX's OpenConditions bridge,
provider, attribution, cache-scope, and integration tests against the resulting
contract. Use a local smoke environment when credentials are not required; do
not substitute a live production check for reproducible contract tests.

### 7. Re-audit and decide automation

Re-run production dependency audits and container scans after all compatible
upgrades and reachability reductions. The prior OpenMapX temporary-exception
prototype is not part of the approved design: remove its exception configuration
and do not commit an advisory allowlist.

Add required and scheduled zero-advisory gates only for ecosystems whose final
production audits can pass without exceptions: OpenMapX root and documentation,
and OpenConditions JavaScript and Python. If an advisory has no safe upgrade or
removal path, stop and present its exact package, version, dependency paths,
runtime/build reachability, upstream fix status, and available choices. Do not
add a warning-only bypass, a permanently red required check, or a temporary
exception.

## Verification contract

OpenMapX verification includes frozen root and documentation installs; full
lint, type, policy, and Vitest gates; documentation build and link/index checks;
mobile tests, Expo doctor, native prebuild checks, and release-bundle inspection
when mobile dependencies change; all affected container builds and scans;
supply-chain pin and catalog validators; and focused OpenConditions integration
tests.

OpenConditions verification includes frozen pnpm installation; build, lint,
typecheck, and complete unit/integration tests; Python lock validation, lint, and
tests; feed lint/check, generated feed schemas, model artifacts, and credential
reference validation; all affected production image builds and scans; and
producer contract tests consumed by OpenMapX.

Inspect every generated diff and run `git diff --check` in both repositories.
Verification reports must distinguish locally executed checks, checks requiring
Docker or native tooling, remote CI, and anything that could not be performed.

## Stop conditions

Stop the current phase and return to the user when:

- the latest release requires changing supported platforms, public API or data
  semantics, product policy, licensing, attribution, or privacy behavior;
- an upstream compatibility matrix excludes the proposed version and no
  supported migration path exists;
- a required patch or override would cross an unsupported API range;
- a catalog update changes rights or provider meaning rather than only format;
- a vulnerability remains without a safe upgrade/removal path;
- current upstream state cannot be verified through an authenticated source;
- baseline or post-change verification fails twice after one evidence-based
  correction; or
- unrelated user work overlaps the required files and cannot be preserved.

At a stop, retain the last green phase, leave later phases untouched, and report
the exact blocker and choices. Never claim a repository, audit, image, PR, merge,
or deployment is complete without fresh evidence for that specific claim.
