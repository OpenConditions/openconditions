# Product release preparation

Product releases are separate from npm library releases. This guide covers the A→B input validator; it does not replace the existing publisher or authorize publication. Keep the default extension services as ingest and contributions-api. Heavy ingest and federation remain opt-ins.

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

Before future publication, replace the old publisher, qualify readiness, configure and read back native future-release immutability and a named approval environment, and obtain final Medformatik approval. Promote the already qualified A bytes without rebuilding. Stage a complete draft before publishing; never overwrite a conflicting published tag or asset. Identity-matching partial work may resume only from the same bound candidate. Expired artifacts require renewed qualification. Preview advances only after coherent publication; missing preview or exact versions fail rather than falling back to main. Stable remains unavailable until separately introduced.

Current latest aliases and historical assets require an explicit compatibility transition before any reset or retirement. Keeping or resetting GitHub release history is a later authorized choice, not an operation performed here. Neither this validator nor its tests qualify channel promotion, protected-environment enforcement, native immutability, live upgrades, registry visibility or a first release.
