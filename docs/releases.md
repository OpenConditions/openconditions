# Product release preparation

Product releases are separate from npm library releases. The old tag/dispatch publisher is retired. The replacement workflow performs manual, read-only qualification only. Image, npm and GitHub release publication are unavailable until a separately reviewed implementation lands. Keep the default extension services as ingest and contributions-api. Heavy ingest and federation remain opt-ins.

## Image source and manifest source

Select a fully qualified protected-main commit A with the trusted CI producer’s complete four-image candidate set. Verify the owning repository, workflow, event, source SHA, run attempt, immutable artifact IDs, digests, Linux amd64 platform, qualification, SBOM and provenance evidence separately. A local JSON file cannot establish GitHub authority. Missing, expired, partial or substituted evidence stops preparation. Older-source image reuse is unsupported.

Prepare B through an ordinary PR. Only extension.json, the four fixed service descriptors, and the selected version’s Markdown and JSON notes may change. Descriptor changes are limited to version, service refs, image tags and digests. Everything else—including configuration, environment, schema ownership, capabilities, service membership, platform and licensing—stays unchanged. Ingest and heavy ingest use the same ingest digest. No real version or production digest is selected by this tooling PR.

Run the validator from a trusted checkout, with immutable commit SHAs and a separately verified producer-input file:

```sh
node scripts/check-release-inputs.mjs \
  --image-source "$A" --release-source "$B" \
  --version "$VERSION" --previous-version "$PREVIOUS_VERSION" \
  --producer-inputs /owned/verified-candidate.json
```

The producer-input file has the same candidate shape as B’s versioned JSON note. It is a caller-supplied binding, not a signed approval receipt. The future qualification workflow must construct it from independently verified native producer evidence. Do not accept it from an untrusted release PR as authority. Select the previous version from a fresh history inventory; the validator checks canonical SemVer ordering but does not query release history or reserve a version.

The candidate has exactly schemaVersion (1), version, imageSourceSha, producer and images. Producer contains workflowFile (`.github/workflows/ci.yml`), runId and runAttempt. Images contains exactly ingest, contributions-api, federation and openlr-resolver. Each entry contains repository, digest, platforms, buildSourceSha, qualificationArtifactId, sbomArtifactId and provenanceArtifactId. Repositories are fixed under ghcr.io/openconditions, sources equal A, and platforms equal `["linux/amd64"]`. Artifact/run identities are positive safe integers. No B SHA, self-hash, URL, command or runtime override belongs in the candidate.

By default the validator reuses the existing immutable Git archive and BuildKit scratch COPY exporter to compare sorted path/hash/mode inventories for all four producer contexts. It never builds or executes service images. `--metadata-only` checks the structural contract and producer-input binding without Docker; its output explicitly says contexts were not checked. That mode is not image-reuse acceptance. Context equality does not establish image qualification, runtime compatibility or host admission.

## Qualification and promotion boundaries

After B merges, independently require full exact-B main qualification. A’s successful CI and B’s PR checks cannot substitute for it. A post-merge artifact must bind A’s original image/run/provenance identities to B’s manifest hashes, successful main run and eventual tag target. Do not claim images were built from B or rebuild them during promotion.

Later stages must validate the actual current OpenMapX portable CLI and community admission contracts, including digest pins, safe configuration and networking. Owned staging still needs clean installation, upgrade from a real prior deployment, migrations, backup/restore and recovery evidence. Live providers, optional federation/TUF and platform variants require their own evidence. A fixture is not host or production acceptance.

Before future publication, implement and review mutation stages, qualify readiness, configure and read back native future-release immutability and a named approval environment, and obtain final Medformatik approval. Promote the already qualified A bytes without rebuilding. Stage a complete draft before publishing; never overwrite a conflicting published tag or asset. Identity-matching partial work may resume only from the same bound candidate. Expired artifacts require renewed qualification. Preview advances only after coherent publication; missing preview or exact versions fail rather than falling back to main. Stable remains unavailable until separately introduced.

Current latest aliases and historical assets require an explicit compatibility transition before any reset or retirement. Keeping or resetting GitHub release history is a later authorized choice, not an operation performed here. Neither this validator nor its tests qualify channel promotion, protected-environment enforcement, native immutability, live upgrades, registry visibility or a first release.

## Manual native qualification (009B)

Run **Product qualification** on main only after A and merged B exist and their exact main CI attempts have completed successfully. Supply immutable A/B commit SHAs, the original A run/attempt, the latest exact-B push run/attempt and the version already committed in B. The workflow does not select or reserve a release version, create a preparation PR, tag a commit, or publish anything. It reads current tags and releases to require an unused canonical SemVer later than their complete supported history; unsupported/non-SemVer or oversized history fails closed instead of guessing a reset policy.

Tools, Node/pnpm inputs and workflow policies come from the owning main checkout. Candidate commits are passive Git objects with replacement disabled. A must be an ancestor of B, and B must be reachable from the workflow's main source. The current policy/tool inputs must match A; older candidates from before this qualification implementation cannot be reused. A policy change requires a new qualified A. Main advancing during the operation causes failure rather than silently switching authority.

The coordinator reuses the native trusted-main image verifier, including its independent downloads, report/OCI checks, artifact hashes, attempt/expiry checks and final rereads. This can download the four image archives during an explicitly invoked qualification; ordinary source tests use owned synthetic artifacts. It creates the 009A producer-input binding from those native results, never from B's committed JSON. B separately needs the latest completed successful exact-source main **push** and all full-main CI coverage. A's run and green PRs cannot substitute. The context checker then performs actual archived BuildKit exports without building service images.

The uploaded `product-qualification-<run>-<attempt>` artifact contains a strict version-1 qualification receipt, not release approval. Its fixed fields bind imageSourceSha, manifestSourceSha and tagTargetSha (B); original A run, artifact references/ZIP digests, image digests/platforms and eligibility; B run/attempt, workflow identity and gate coverage; extension/service/note SHA-256 values; effective context inventories; and a hash of the version-history names checked. `validate_receipt` rejects unsupported fields and bindings. Eligibility cannot outlive A's original evidence. A future consumer must verify the native qualification run and revalidate authority, not trust an arbitrary local receipt.

The final API reads recheck A's current attempt/artifacts, B's latest exact-source attempt, main and version history. These reads are not atomic with each other, artifact upload, later policy changes or eventual publication. Later stages must repeat eligibility and identity checks after approval. Host admission, staging readiness, approval, immutability, publication and channels are explicitly `NOT_IMPLEMENTED`; neither a successful qualification nor its upload claims them. Optional CII/Scorecard policy, registry access and live provider acceptance remain separate.

Source retirement does not erase historical workflow definitions. Native safeguards against invoking old refs, and the eventual mutation workflow, still require separate qualification before publication. Historical releases and image aliases are unchanged by this PR.
