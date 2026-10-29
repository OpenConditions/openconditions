# Security triage

Report vulnerabilities through [SECURITY.md](../SECURITY.md). Keep sensitive diagnostics and reproduction details in private evidence. Test only with synthetic values and owned disposable resources; do not probe providers or deployed services.

## Refresh the evidence

Start with the current default-branch SHA and record the observation time. Fetch every page of code-scanning and Dependabot alerts, including closed records needed to reconcile earlier work. Preserve each alert ID, state, tool, category, source commit, analysis/run/attempt and complete SARIF result, including related locations and flows. Group repeated patterns for investigation while retaining every individual ID. Track PR-only findings separately from main.

Check that each analysis belongs to the intended source and ref. CodeQL's JavaScript/TypeScript and Python categories, Scorecard governance findings, dependency advisories and image scans answer different questions. Pending, missing, failed or stale evidence remains unqualified. A successful reconciliation job or green analysis does not establish full main qualification or an empty backlog.

For dependency findings, trace the resolved package and its runtime, development or build use against the upstream advisory's affected range and prerequisites. Reuse audits only when their actual inputs match, retaining the source hashes and original results. Otherwise run the relevant pinned audit and preserve nonzero, malformed or unavailable results. Follow the [verification commands](../CONTRIBUTING.md#quality-bar) and keep unrelated findings visible.

## Qualify and act

Trace each finding from its actual caller and input owner through validation, normalization and the sink. Record deployment assumptions, bounds and what a caller can change. A credential reference is different from its resolved value; a property write needs a prototype/validation assessment; a filesystem check needs an ordering and replacement-authority assessment. Test-directory placement and operator ownership alone establish no exemption.

Use bounded local causal cases through the real public or application path. For parser work, prove that valid controls reach the target before malformed input, and separate bootstrap time from matching work. Preserve failed and superseded attempts. A repair should retain the existing contract and add a regression that fails on the old behavior. Follow the owning verification requirements before review.

Classify the result as a confirmed repair, precise false positive, obsolete finding, affected but bounded, or unresolved. Record an owner, confidence, evidence and a concrete review trigger. Keep affected or uncertain findings open unless a separate risk-acceptance decision authorizes otherwise. Do not use blanket dismissals, directory exclusions, threshold reductions or a zero-alert quota.

Before changing an alert, independently review its exact proposed reason and comment. Immediately reread the native record and compare the current source, tool, category, location, message and complete flow with the reviewed evidence. Stop that operation on meaningful drift. Save the original, request, response and readback; reconcile an unknown write outcome without retrying or rolling back someone else's changes. A merged fix becomes native-fixed evidence only after a matching main analysis and alert readback support that status.

## Native CodeQL protection

The active main ruleset selects `CodeQL` with `security_alerts_threshold: high_or_higher` and `alerts_threshold: none`. The latter disables the general alert-severity threshold; it does not disable security-alert protection. Scorecard is not selected. Both language analysis checks remain required alongside the other [repository safeguards](repository-guardrails.md#required-checks). A green synthetic check or generic blocked merge status alone cannot attribute a native rule outcome. GitHub documents the separate thresholds in [code-scanning merge protection](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection).

A controlled, never-merged probe PR demonstrated explicit native blocks for a JavaScript High finding and a Python High finding, both scored 7.5. Removing those findings and retaining only a Python Medium finding scored 6.1 removed the native security block; its unresolved conversation still blocked merging independently. The final clean source had zero results in both categories, successful applicable CI and a native ready-to-merge display. No merge or bypass was attempted. The probe PR was closed without merging, and its temporary rule and remote branches were removed.

Missing-category, missing-all/stale-result and failed-analysis cases were not experimentally tested. Neither were a separate Critical fixture, actual merge/bypass, merge queue, Dependabot, default setup or platform variants. Critical inclusion follows the configured High-or-higher threshold. Preserve these limits when changing tool identity, workflow categories or protection; any new experiment needs its own bounded authorization and cleanup.

## Remaining review decisions

Maintainers retain ownership of these qualified residuals and revisit them when the stated boundaries change:

- Request-cost protection needs an endpoint-specific decision about pre-authentication work, identity, trusted proxies and multiple replicas. Report-submission accounting does not provide generic request throttling. Reassess when routes, topology or admission controls change.
- Operator PEM, private probe, configured/layout and HTTP Authorization regex findings require their own caller and input-bound analysis. Wire header limits do not establish safety for every library caller. Reassess when input ownership, parsing or deployment exposure changes.
- The TMC generator's unpinned archive and system extraction path need an explicit integrity, edition, resource and supported-platform contract. Remaining CLI exception paths need current flow qualification. Reassess changes to download/extraction authority, credential handling, serialization or validation.
- Scorecard review and branch-protection scores must be interpreted against the chosen single-maintainer policy. External best-practices certification is a separate owner decision. Reassess policy or detector changes without inventing reviews, certification or accepted risk.

## Source and artifact acceptance

Keep local regressions, PR checks, exact merged-main qualification, image qualification and deployment evidence separate. After merges, reconcile every intended security hunk and regression against the combined tree. Whole-file equality is useful where true; legitimate combined edits require contract review. Retain the original source heads and evidence.

For images, bind the owning run and attempt, source/context identities, qualification result, runtime SBOM and OCI digest to the same candidate. See [container qualification](container-qualification.md) and [trusted main image evidence](trusted-main-image-evidence.md). Missing artifacts, registry failures or uninspected platform variants are unknown. A source fix, successful audit or retained artifact grants no publication, release, ARM64 or deployment acceptance.
