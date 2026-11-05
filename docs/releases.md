# Product releases

Use **Actions → Product release** on main. The workflow has three explicit operations:

1. **Prepare**: enter a version and curated notes. CI checks current main and its original image artifacts, then opens a normal preparation PR containing exactly seven metadata files. Review and merge it normally. GitHub may require maintainer action to start checks on a bot-created PR; the summary links the PR and explains the next step.
2. **Review**: enter the committed version. CI verifies source, images and manifests, runs the bounded installation/recovery and rights/privacy checks, and uploads the complete review artifact. Inspect the readable summary, notes and results. Review has no publication permissions.
3. **Publish**: enter the same version. CI repeats those checks, then waits for one approval in the native `product-release` environment. After approval it rechecks the exact artifact and current source, copies the original tested images without rebuilding, verifies the complete draft assets, publishes the immutable prerelease, and moves preview last. No stable channel is moved.

Run IDs, image digests, local paths and passing readiness JSON are not operator inputs. Pending or failed current-main CI blocks the operation with a diagnostic; an older green run, PR or fork cannot substitute for it. Product publication does not publish npm packages or deploy a host.

## Owner setup, once

Before the first publication, configure the **product-release** environment with a required maintainer reviewer and restrict deployment branches to **main**. Self-review is allowed for this single-maintainer repository. The native environment gate supplies approval; the workflow also rejects a missing reviewer rule to catch an accidentally auto-created unprotected environment. Allow Actions to create preparation PRs through the normal repository setting.

Enable [release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes) in the repository settings. This is owner setup, not a per-release administrative API check or a reason to create an App/PAT. Publication reads the release's own `immutable` status before moving preview. If immutability has been disabled, publication stops with preview unchanged; the release may already have been published. Setup and later administrator changes are not an atomic security boundary.

## What is checked

Image source **A** is the successful main commit that built the four original Linux amd64 images. Manifest source **B** is the later main commit containing the reviewed preparation. A green A or preparation PR does not qualify B. The workflow independently verifies B's successful main checks, A's native artifact IDs, ZIP digests, reports and expiry, and unchanged application build inputs through all four effective BuildKit contexts. Only the permitted descriptor version/image pointers and curated notes may change between A and B. The release tag targets B; image provenance continues to name A.

The pinned public OpenMapX CLI and admission implementation check the extension and all service manifests. CI builds these tools in its own installation from reviewed source and dependency inputs; it does not depend on a developer's Mac cache. Default services remain ingest and contributions-api; heavy ingest and federation stay opt-in. Configuration, networking, licensing, membership and schemas cannot be changed as release metadata. Such a change needs an ordinary source PR and newly qualified image source.

The review artifact contains the exact descriptors, candidate, notes, source/image provenance, qualification, actual SBOM/scan bytes, portable/admission results and bounded test results, with a complete hash inventory. Publication accepts only the successful owning job's digest-bound artifact. It rechecks source, current main CI, original images, history and expiry after approval. No rebuild or expiry renewal is performed during promotion.

## Tested scope

The default-service rehearsal starts the original ingest and contributions-api images on an owned internal network with synthetic configuration and remote feeds disabled. It checks migrations and health, writes a synthetic marker, stops the service, dumps the migrated schema, drops and restores it, verifies the marker, then restarts and checks health. Owned resources are cleaned up, and failed cleanup fails the operation. Separate integration fixtures exercise representative rights/privacy behavior against disposable databases.

This is bounded Linux amd64/PostgreSQL 16 installation and recovery evidence, not a new production support policy or comprehensive certification. It does not prove an upgrade from an actual prior deployment, optional federation/TUF, every provider/privacy contract, live feeds or other platforms. Review these limits and the release-specific notes when deciding whether to approve. The workflow never accesses an operator database or performs a live installation.

## Conflicts and interrupted publication

An existing identical version, image or asset is verified and reused. A conflicting tag target, digest, release identity or asset stops before overwrite. Failed or unknown writes stop without automatic retry, rollback or deletion: inspect GitHub/GHCR read-only before rerunning the same unexpired candidate. To resume the same review artifact, rerun the failed publication job in its original Actions run while the evidence remains valid. A new complete validation run can produce different execution evidence and is not an identical retry. A changed candidate or expired original evidence needs fresh qualification, not a reset of its timestamps.

Preview moves only after the complete immutable release and version images are confirmed. Its four tags update sequentially: an interruption can leave mixed preview versions. Inspect the native digests and resume the identical candidate to finish. GitHub/registry reads and writes are not transactional; final read/write races remain. Existing latest/history consumers are untouched, and main remains development. Merging this source does not select a version, create a release, configure protections or publish anything.
