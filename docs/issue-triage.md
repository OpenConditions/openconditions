# Issue triage

The forms request native Bug, Feature and Task types; feed requests use Feature. Native form rendering and automatic type assignment still need acceptance on a legitimate future issue. Local YAML/schema checks alone do not establish that acceptance.

## Intake and evidence

Use Bug for observed unexpected behavior, Feature for a desired capability and Task for bounded work. A reported bug can remain unconfirmed. Keep uncertain classification for maintainer review and ask for specific missing facts without requiring a diagnosis, a latest-main checkout or invented estimates.

Identify the running artifact when possible: image repository and digest, package version, release asset or deployment identifier. A local git HEAD describes that checkout and may not identify deployed software. Preserve reproduction attempts, intermittent behavior, actual results, timestamps and useful measurements. Keep logs, tables, links and attribution intact; redact secrets and personal data before posting.

Feed requests can name any current catalogue domain: roads, fuel, parking, charging, cameras, hazards, weather, vehicles or border. Unknown format, access or license details are acceptable at intake. Confirm reuse rights, attribution, rate limits and access conditions before activating a feed. A supported format can use a regional JSONC entry in the [catalogue](../feeds/README.md); new formats may require parser/domain work. The [ingest domain registry](../services/ingest/src/domains.ts) is the current integration list.

## Target labels

The repository uses these ten labels, and the forms, updaters and reporting producers use the reconciled names. [GitHub only adds form labels that already exist](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms). Keep new or changed producer references consistent with this taxonomy and verify that their labels exist before use.

| Label            | Use                                                     |
| ---------------- | ------------------------------------------------------- |
| needs-triage     | Work awaiting maintainer classification                 |
| needs-info       | Waiting for specifically requested information          |
| blocked          | Waiting for a named dependency or decision              |
| dependencies     | Dependency updates                                      |
| documentation    | Documentation, links and contributor/operator guidance  |
| feed             | Catalogue, parser or provider integration work          |
| ci               | Repository checks and automation                        |
| docker           | Container builds and runtime packaging                  |
| good first issue | Bounded contributor work with clear completion criteria |
| help wanted      | Work where maintainers welcome contributor help         |

Issue types replace bug/enhancement labels on issues. Conventional Commit titles classify PRs. Identify generated reports using author together with the producer's known title, branch or report marker; a generic automated label is unnecessary. Do not infer a label for each library, language or protocol.

## Maintainer decisions

Read the reported outcome and evidence, then assign a justified type and relevant labels. Use needs-info with a concrete question. Use blocked with the dependency and the condition that would unblock the work. A new comment alone does not establish that missing information or a blocker is resolved.

Priority and Effort are optional maintainer metadata. Leave them unset until evidence supports a value. Public visibility has been explicitly deferred; both fields remain internal. Preserve existing field and option identities when revisiting that organization-level change. Start/target dates remain optional and internal.

The guarded [issue lifecycle](issue-triage-automation.md) is enabled: eligible opened/reopened issues receive needs-triage, and eligible closed issues lose needs-triage, needs-info and blocked. Preserve closure reasons and links to duplicates or follow-up work. Review delayed, ambiguous or failed transitions manually rather than assuming the automation completed them.

Feed and link monitoring distinguish completed healthy/unhealthy checks from execution or reporting failures. Keep report diagnostics and useful provenance, including source, run, time and coverage when present. A partial or keyless check is not proof that every feed recovered. Healthy results recommend manual resolution review; they never automatically close or reopen an issue. Resolve a report only with evidence relevant to its failure and preserve its history. Real provider and native reporting acceptance remain separate from source and fixture checks.

## Writing and migration

Write paragraphs naturally without manual prose hard wrapping. Preserve intentional Markdown, code, diagnostic bytes, measurements and attribution. Do not cosmetically rewrite bot reports or other authors' comments. Historical text changes need their own factual review and exact before/after receipts.

Before live migration, refresh labels, issue/PR metadata, hashes, updated times, native types and field values. Keep an exact operation manifest and abort on drift. Migrate references and justified record metadata before deleting obsolete labels; retain duplicate/closure context and send uncertain classifications for human review. Re-read each write after activation. Historical writing, organization/account activation and legal/CLA terms remain separate from source producer updates.
