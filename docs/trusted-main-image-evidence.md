# Trusted-main image evidence

This is a factual, nonpublishing producer receipt for the four fixed images. It is not a signed SLSA
attestation, registry manifest authority, approval to promote an image or a product readiness receipt.
PRs, forks, feature-branch dispatches and audit-only schedules cannot produce it. Ordinary PR image
qualification and both CodeQL languages still run on stacked PRs.

The `trusted main image evidence` job follows successful `full main qualification` in the owning
repository's `ci.yml`. It has only contents/read and actions/read permissions. It checks out the exact
source SHA without persisted credentials and never logs in to a registry, requests OIDC or executes
artifact code. The old tag publisher is outside this change.

## Authority and exact inputs

The producer treats its environment as a claim, then independently reads GitHub's repository, fixed
CI workflow, current run, exact attempt and complete job inventory. Both repository IDs, workflow ID
and path, owning main branch, push/manual-main event and exact source must match. All current source
jobs, all four image jobs, image aggregate, required CI and full-main marker must have actually
completed successfully. Missing, unknown, duplicate, cancelled or skipped coverage fails. The producer
itself is still running at this point; requiring its entire workflow to have completed would be circular.
Independent CodeQL and current repository/release policy remain separate requirements; this receipt
proves the CI marker's recorded coverage and cannot substitute for those checks.

Each image comes from the same run and attempt's uniquely named `image-<role>-<attempt>` artifact.
The API's immutable ID, owning run/repository/source, ZIP SHA-256, size, expiry and successful upload
step's time window must agree. The attempt-scoped jobs endpoint, attempt-specific names and upload
windows bind artifacts to that attempt; the artifact API does not expose a separate job/attempt field.
The validator never accepts a receipt's run claim as API authority. It downloads by immutable API ID,
verifies the entire ZIP hash and size, rejects unexpected paths, duplicates and nonregular entries,
and revalidates the full OCI blob graph and all existing qualification reports. It never unpacks or
executes image layers. Substituted reports, SBOMs, archives, digests and forged `qualified.json` fail.

JSON API responses are bounded to 5 MiB, pagination to 1,000 records, each ZIP and its uncompressed
contents to 2 GiB, artifact JSON files to 16 MiB and logs to 32 MiB. Chunked reads enforce a 15-minute
transport budget with at most a 30-second blocked socket read inside a 30-minute job. GET
transport retries are bounded to three retries; schema, permission and validation errors fail visibly.
Artifact storage redirects must be HTTPS on GitHub Actions/Azure artifact hosts; the API token is
never forwarded to storage. There are no command, URL, repository, workflow or branch selectors.
Run/attempt IDs and a lowercase full source SHA are the validator's only authority selectors.

## Files and the Plan009 handoff

The `trusted-main-images-<attempt>` artifact contains exactly five canonical JSON files:

- `candidate.json`: schemaVersion 1, buildSourceSha, independently verified producer identity, executed
  coverage, earliest original image expiry, exactly four images and `releaseAuthority: false`.
- `<role>.provenance.json` for ingest, contributions-api, federation and openlr-resolver: schemaVersion
  1 factual producer receipts, original qualification artifact API identity, report hashes, all OCI
  identities, and build-log hash. `signedAttestation` and `registryAuthority` are false.

The producer identity includes owning repository ID, workflow file/ID, run/attempt/event, and the Git
blob and SHA-256 of the CI workflow at the exact build source. That source records declared setup
pins; original build logs/metadata, runtime records and SBOMs retain the observed native/scanner
information. They do not establish reproducible builds or complete vulnerability/license coverage.

Archive byte hash, OCI index content hash, platform manifest digest, configuration digest and Docker
runtime image ID remain distinct. The fixed repository names are intended future destinations, not
claims of registry publication. Only the actually qualified Linux/amd64 platform is recorded.

A producer cannot include its own future upload ID/hash. The later read-only `validate` operation
independently resolves the candidate artifact's fixed name, verifies its API identity/hash and all five
files against freshly revalidated original image artifacts, and additionally requires the whole exact
latest run/attempt and candidate upload job to have completed successfully. A partially rerun workflow
with stale image evidence cannot qualify. Run/attempt, artifact metadata and expiry are checked again
after transfers; an advancing attempt or expired evidence fails.

The validator returns exactly the seven Plan009 image fields: repository, digest, platforms,
buildSourceSha, qualificationArtifactId, sbomArtifactId and provenanceArtifactId. Qualification and
SBOM IDs refer to the same original image bundle; the provenance ID refers to the single immutable
candidate artifact containing all four factual receipts. These IDs are deliberately shared where their
files share one artifact. Plan009 maps producer workflowFile/runId/runAttempt explicitly into its
strict release-metadata schema; it must not copy extra fields or accept arbitrary URLs/runtime overrides.

Both image and candidate retention stay at three days. Eligibility ends at the earliest original
expiry, including the candidate's own expiry; copying/uploading a receipt never renews source evidence.
Deleted or expired artifacts require new ordinary full-main qualification. No cache is authority.

## Use and acceptance limits

Ordinary CI calls `assemble` automatically only after successful full owning-main coverage. The
read-only validation command for a later explicitly selected producer is:

```bash
python scripts/trusted-main-image-evidence.py validate --source <40-lowercase-hex-source> --run-id <positive-id> --run-attempt <positive-attempt>
```

It uses the caller's existing read-only `GH_TOKEN`; this work requires no PAT/App bootstrap and does
not run a real main dispatch as a rehearsal. The output has `releaseAuthority: false` even after valid
API-backed evidence. Protected-main producer execution remains pending until this source is merged.
Offline HTTP/filesystem fixtures and green stacked PRs do not establish that operational acceptance.

Plan009 must still verify current policy, the merged and qualified metadata/context separation before
selecting image source A, exact A-to-B JSON pointers/value bindings and unchanged build contexts, full
protected-main B qualification, original image provenance, platform/runtime/readiness and final human
approval. No future B SHA or self-hash is recursively committed into source A. No image is rebuilt,
retagged, promoted or published by this producer/validator pair.

API contracts: [GitHub artifacts](https://docs.github.com/en/rest/actions/artifacts),
[workflow runs and attempts](https://docs.github.com/en/rest/actions/workflow-runs), and
[attempt-scoped jobs](https://docs.github.com/en/rest/actions/workflow-jobs).
