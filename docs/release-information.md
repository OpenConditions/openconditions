# Release information

Describe the change, its checks and any user action in ordinary PR prose. Authors and reviewers decide whether a public package change deserves a Changeset or whether product notes would be useful. Routine PRs do not need declarations, waiver text or a separate operator fragment. Bots follow the same source checks as people.

## Package notes

Run `pnpm exec changeset` when preparing a consumer-facing package note. The qualified allowlist currently contains OCPI only; other packages remain private. Notes must name an allowed public package, select a patch/minor/major bump and contain a summary. The installed Changesets parser validates the format. There is no automatic relevance classifier or requirement to add a note for every source or dependency change. npm versions remain independent of wire-schema identifiers.

The existing Node CI job runs `pnpm check:release-information --base BASE_SHA --head HEAD_SHA`. It reads immutable Git objects, validates queued notes against the base allowlist, and checks whether a public package version changed or a queued note was consumed. PR body text, author, title and branch are not inputs. Ordinary changes do not install another dependency tree or invoke version generation through this check. The separate PR-title workflow only runs the pinned conventional-title action; body edits do not start release validation or full CI.

## Version preparation

`pnpm version:public-packages --check` validates the queue through installed Changesets and reports its pending count. An empty queue reports `pending: 0` without changing tracked files. `pnpm version:public-packages` applies Changesets and updates the pnpm lock without lifecycle scripts. Review the resulting files in a normal PR; these commands do not publish or tag anything.

Only an actual public version edit or consumed note triggers canonical validation in CI. The existing verifier creates an isolated clone of the trusted base, installs its frozen dependencies offline with lifecycle scripts disabled, then replays installed Changesets and the pinned pnpm lock update. It compares the complete resulting Git tree, including versions, lock, changelog and consumed notes. Hand-edited or empty-queue bumps and extra source changes fail. The base's locked dependencies must be available in the local store; missing inputs produce an error rather than an exemption. The clone owns its installation and leaves caller tools untouched.

## Product notes

Use clear release notes when they help someone understand compatibility, a migration or an action they need to take. A Markdown note in `docs/release-notes/` is optional for ordinary work and has no prescribed fields. Curate those notes for an actual product preparation. Package checks, packed-consumer qualification, licensing, privacy and product release safeguards continue to apply independently; prose grants no publication or deployment authority.
