# Release information

Use a focused Changeset when a qualified package's behavior, declarations, exports, runtime dependencies or delivered build changes for consumers. The allowlist currently contains OCPI only. Other packages remain private; npm versions do not version wire-schema identifiers. Bots follow the same rules as people.

Run `pnpm exec changeset` to write a note. Unknown/private package names, empty summaries and invalid bump types fail validation. For a delivered-surface edit without consumer effect, write `Package release: none —` followed by a specific reason in the PR body. Reviewers must assess the explanation; a length check cannot establish semantic equivalence. Documentation, test-only and internal changes need no empty bookkeeping. Ordinary product features and fixes use clear PR text.

Authors and reviewers declare important operator impact instead of relying on keyword guessing. For breaking public contracts, migrations or significant security/operator action, write `Product release: operator-impact docs/release-notes/name.md` and commit the corresponding fragment. Consider canonical model/schema, HTTP/GeoJSON/XML/TraFF/Parquet consumers, catalogue JSONC, federation/TUF/registry YAML and PostGIS migrations. This is release information, not a new compatibility, security, licensing or support policy.

## Local validation

`pnpm check:release-information --base BASE_SHA --head HEAD_SHA --pr-file metadata.json` validates immutable Git revisions. The metadata file contains a positive PR `number`, exact `base` and `head` SHAs and the unexecuted `body` string; a GitHub pull-request event file is also accepted. The base allowlist supplies authority. Runtime dependency lock closure is compared separately from unrelated development-tool changes. File heuristics identify review candidates; they cannot infer breaking changes, operator significance or correctness of a non-release reason.

CI runs the gate inside the existing required Node job. The existing required PR-title job also runs it using trusted base code on opened, synchronized, reopened and edited events. Body edits revalidate this small job without canceling or restarting full CI. The target workflow installs only trusted-base tools with lifecycle scripts disabled, reads candidate Git objects without executing candidate source, and refuses concurrent head/base/body drift. Its final read is a fence, not an atomic lock against a later edit. The workflow becomes available after this baseline merges; the baseline PR is validated by the unprivileged Node job.

## Version preparation

`pnpm version:public-packages --check` validates notes through the installed Changesets tool and reports the pending count. With an empty queue it reports `pending: 0` without mutations. `pnpm version:public-packages` applies installed Changesets and updates the pnpm lock without lifecycle scripts. This prepares files only; it does not publish or tag anything. Review the resulting diff before committing.

A generated-version PR declares `Package release: version`. Validation replays installed Changesets and the pinned pnpm lock update from the exact trusted base in a disposable local clone, then compares the complete resulting Git tree, including changelogs and consumed notes. Author, title and branch confer no exemption. Empty-queue fabricated bumps, extra source changes, allowlist changes and product fragments cannot pass canonical replay. This requires the base's pinned dependencies in the local store; missing/offline inputs fail rather than granting an exception. No registry ownership or prior publication history is inferred.
