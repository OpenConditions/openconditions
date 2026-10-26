# Repository guardrails

Changes to the protected default branch `main` use a pull request. GitHub enforces zero required approving reviews, resolved review conversations, linear history, and protection against branch deletion and force pushes. Code-owner approval and approval of the last push are not mandatory. There is no merge queue or strict branch-freshness requirement. Review and checks should remain meaningful even though a human approval is optional.

## Required checks

The main ruleset retains the existing six contexts and requires the complete CI aggregate and dependency review. Each context is bound to its observed GitHub Actions producer (integration ID `15368`):

- `typecheck / test`
- `python lint / test (openlr-resolver)`
- `Validate conventional commit title`
- `check / record signature`
- `Analyze (javascript-typescript)`
- `Analyze (python)`
- `required CI`
- `review dependencies`

`required CI` accepts only successful execution of every applicable source, TypeScript, Python, independent interop and zero-finding production-audit outcome. The weekly audit-only schedule has its own allowed skips. Dependency review is separately required. Both CodeQL language analyses remain required; a successful analysis does not mean that all security alerts have been resolved. No CodeQL severity-threshold rule is enabled by this guardrail change. The separate synthetic `CodeQL` check is not substituted for either language context.

Successful PR CI is distinct from exact post-merge `full main qualification`. Native Dependabot patch/minor auto-merge remains subject to the applicable protections. Trusted main reconciliation and its bounded recovery behavior are described in [CONTRIBUTING.md](../CONTRIBUTING.md#main-validation-and-required-checks); a legitimate bot merge must still qualify that operational path independently.

## Merge and Actions settings

Squash is the allowed merge method. The default squash commit uses the PR title and body, so edit them before merging when the final change differs from the original proposal.

Remote Actions must use full commit SHAs. Local actions and reusable workflows are inventoried separately; the repository currently has no local `uses:` references. The allowed-actions policy remains `all`; SHA enforcement does not create an Action allowlist. Workflow tokens default to read permissions, workflows cannot approve pull requests, and first-time contributors require workflow approval. Secret scanning and push protection remain enabled.

Release immutability is not enabled while the existing publisher still creates a release before uploading or replacing assets. Replacing that publisher and deciding any release-history transition are separate work. This policy does not authorize a release, package publication or deployment. Enabling workflows to create pull requests is also a separate decision.

## Maintainer emergency process

Repository administrators have a pull-request-only emergency bypass. This preserves a PR and its audit trail; it does not authorize routine direct pushes to `main`. Agents never have standing bypass or merge authority.

An administrator considering an emergency bypass must record the incident reason in the PR, identify each failed or unavailable check, describe the verification that was possible, and name the follow-up needed to restore ordinary checks. Resolve review conversations and preserve evidence of the bypass. Normal work waits for the checks; recurring failures are repaired instead of repeatedly bypassed. A bypass must not be used to perform a release or deployment without its separate authorization.

## Private security reporting

Use [Report a vulnerability](https://github.com/OpenConditions/openconditions/security/advisories/new) from the public [Security page](https://github.com/OpenConditions/openconditions/security). GitHub sign-in is required to submit a report. Maintainers with advisory permissions can create a draft advisory directly. See [SECURITY.md](../SECURITY.md) for the email fallback, best-effort response targets, credit, anonymity and safe harbor.

Public discovery and the enabled repository setting can be checked without submitting a vulnerability. They do not prove that an independent signed-in non-maintainer can complete the form, that an owner has reviewed notification routing, or that the fallback mailbox is monitored. Those account and delivery checks require separate evidence; do not send test reports or email merely to label them accepted.
