# Issue triage automation

The guarded issue label lifecycle is enabled with the reconciled ten-label taxonomy. It does not migrate history, assign issue types or change organization fields. See [issue triage](issue-triage.md) for intake, metadata and maintainer decisions.

## Activation and scope

The repository variable `ISSUE_TRIAGE_LIFECYCLE_ENABLED` is set to `true`. Producer label references, including the TUF updater, are reconciled and all ten target labels exist. For any later reactivation, verify current producers, label identities, trusted main qualification and effective repository/organization variables before enabling the guard. Validate native behavior on legitimate future issue events; activation and source tests alone do not establish that acceptance. Do not create test issues or dispatch the workflow to manufacture it.

Only `issues` opened, reopened and closed events are eligible. A fresh new/reopened issue receives needs-triage; a closed issue loses needs-triage, needs-info and blocked. Operations add one label or remove one owned label at a time. Other labels, types, priority, effort, bodies, comments, state and closure reasons are untouched. Comments do not resolve a question or blocker. There is no stale closure, locking or automated comment.

## Authority, races and failure

The helper binds the fixed repository ID/name, issue database/node/number identity, action, timestamp and transition actor to the current API readback. Only trusted default-branch workflow code runs with issue-write permission. No issue/PR-selected code, command, URL or ref is executed. Missing target labels block the run without creating labels.

The ten-minute event freshness limit deliberately leaves delayed or ambiguous events for review. Paginated history identifies later close/reopen transitions and label decisions. A human removal after the event stays removed. Same-second ambiguous transitions, changed issue snapshots and incomplete history stop mutation. The per-issue concurrency group reduces overlap but does not promise event ordering.

GitHub's [label API](https://docs.github.com/en/rest/issues/labels) does not document an atomic transaction with issue state. Repeated state/history fences precede every narrow write, and readback must show the expected issue, labels and exactly one new Actions-owned label event. A change after the final read can still race with that write. A detected post-write race or unknown outcome fails visibly and stops further writes; it does not claim rollback or a clean issue. Do not blindly rerun a failed write. Inspect the current issue and event history, preserve human decisions, and repair any remaining drift through reviewed maintainer action. An idempotent redelivery cannot override a later label removal. No write is retried automatically.

The API budget is sixty seconds with a ten-second request timeout and at most twenty pages per collection. Permission, schema, pagination, transport and readback failures remain visible. No arbitrary endpoint is accepted by the production command, and no dependency installation runs in these workflows.

## Read-only drift report

The separate workflow runs monthly and permits manual execution from main. Its token has contents/read and issues/read only, and the helper's adapter rejects every mutation before HTTP. It paginates current repository records, excludes PRs and reports closed issues retaining workflow labels and missing target names. The JSON artifact and job summary are observations, with zero repairs performed; they do not prove native lifecycle acceptance, assign missing metadata or infer priorities. Inventory is not an atomic repository snapshot, so API/schema/duplicate/pagination errors fail the report rather than presenting a complete clean result.

Artifacts are retained for three days. The report creates no issues, comments, labels or notification changes. Existing feed/link monitoring completion and recovery remain outside this workflow.
