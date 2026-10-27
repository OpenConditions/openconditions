# Feed liveness reporting

The protected-main scheduled/manual workflow installs the frozen dependencies, builds the existing domain prerequisites, checks the whole catalogue in explicit keyless mode and verifies the completion receipt before reporting. A missing `found` output is never evidence of success. Checkout and setup failures remain failed workflow steps; the always-run summary records their outcomes and leaves coverage unknown when no validated receipt exists.

| Result                                                        | Workflow result               | Evidence/report behavior                                                |
| ------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| Complete healthy applicable keyless check                     | Success                       | Artifact and summary; maintainer recovery review only                   |
| Complete provider/reference/empty-result warnings             | Success if reporting succeeds | Bot-owned failing-feed report with redacted diagnostics                 |
| Complete parse/format errors                                  | Failure                       | Same bound diagnostics are reported before the failing exit             |
| Install, build, catalogue or checker execution failure        | Failure                       | Incomplete receipt/logs; no canonical report update                     |
| Partial, stale, inconsistent or substituted evidence          | Failure                       | Retained for diagnosis; no canonical report update                      |
| Report generation, API, readback, summary or artifact failure | Failure                       | The failing stage stays visible; writes are never retried automatically |

## Scope and evidence

`pnpm feeds:check` keeps its existing manual behavior. `--keyless` excludes authentication and referenced secret fields before resolving any credential or credential file, even if a value is present. Public instance settings with defaults remain eligible. Missing configuration is partial applicable coverage. Disabled and keyed feeds are counted separately; on-demand feeds use their configured probe cell only. Provider/network warnings and parse failures retain their existing exit semantics.

The checker writes `--result <path>` JSON and `--report <path>` Markdown with source SHA, repository, run/attempt, start/check/finish times, selection, completion, checked/skipped coverage and outcomes. Local runs without Actions identity record unavailable context and cannot become protected workflow reporting authority. The wrapper independently binds the fixed repository/main workflow, immutable clean Git checkout, source/run/attempt, fresh times, complete unique outcome inventory, exit code and report hash. It reads only fresh owned output, using opened regular files rather than a pathname stat/read pair. Build and provider children receive no GitHub reporting token.

`liveness/execution.json` separates checker validation from reporting completion. Raw incomplete checker output is diagnostic data, not authority. A complete healthy run recommends review against the checked IDs and scope; it never asserts that keyed, disabled, removed or untested feeds recovered. It writes no issue, comment, close or reopen operation. Whole-job acceptance still requires the actual workflow outcome, including artifact upload.

## Report ownership and failures

Complete unhealthy applicable evidence may create a report with the target `feed` label, which must already exist and be active. The source does not create labels. Existing reports require the fixed title and GitHub Actions bot identity; a matching human issue or ambiguous inventory blocks reporting. Updates patch only the body, never issue state, labels, native type, fields or comments. There is no automatic closure, reopening or stale-issue policy.

On the first refresh of a recognized legacy bot report, the previous diagnostic body is retained byte for byte below the new managed section. Later refreshes preserve text outside that section and refuse edits to its checksummed diagnostics. The checksum detects content changes; it is not a signature or attestation. Current API identity/body readback provides the reporting check. A preflight read and body update are not an atomic GitHub transaction, so concurrent edits remain a residual risk. Detected drift or an unknown write outcome fails visibly without retry or rollback; maintainers inspect the current report and retained evidence before repair. Oversized bodies fail instead of truncating diagnostic history.

Artifacts retain receipts, reports and process logs for three days. API pagination and requests are bounded. Provider scheduling remains serial with the existing endpoint/cadence behavior. The explicit 360-minute job bound preserves the former Actions default: the observed 42m56 run does not justify a 15-minute cutoff or a universal runtime claim. No new provider fanout, credentials or live keyed-feed tests are introduced.

## Integration and acceptance

This independent source batch overlaps PR259's single feed-liveness label hunk. The ignored execution receipts contain an exact patch from that workflow to this one; retain this completion pipeline and its `feed` producer when reconciling the merge. Do not restore the old action's `feed-issue` label. PR251's TUF updater label reconciliation is a separate gate.

Live taxonomy, legitimate scheduled/manual producer execution, API/notification behavior and native recovery review remain unqualified until coordinated merged-source acceptance. This batch performs no live issue/history/label writes or workflow dispatches. Links monitoring is separate work.
