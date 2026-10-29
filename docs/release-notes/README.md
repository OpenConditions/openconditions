# Product fragments

Create `docs/release-notes/short-name.md` only for meaningful operator-facing release significance, and reference it with `Product release: operator-impact docs/release-notes/short-name.md` in the PR body. Ordinary features and fixes can stay in clear PR prose for later curation. Do not fabricate a baseline fragment.

Use these fields with concrete content:

```text
Affected versions: Identify the actual affected versions or unreleased scope.
Action: Explain the required operator or consumer action.
Compatibility: State the breaking behavior, migration or compatibility boundary.
Caveats: Record limitations and remaining qualification needs.
```

Fragments provide information for a future release. They authorize no publication, deployment, schema renumbering or risk acceptance.
