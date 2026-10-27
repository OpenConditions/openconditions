<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

Local pre-commit checks only staged Biome-owned TS/JS/JSON/JSONC and Prettier-owned Markdown/YAML,
using an isolated index snapshot without rewriting or staging files. Keep feed JSONC overrides and
Python's own tooling. Commit messages still use commitlint; push runs no automatic workspace suite.
Use focused tests while iterating and `pnpm verify:full` for deterministic Node verification before
review (Docker/PostGIS required). Python lint/tests, independent interop and production audits are
separate commands and remain required CI coverage; see CONTRIBUTING.md. Do not add workspace builds,
typechecks, tests or downloads back to commit/push hooks.

For contributor-facing writing, use natural paragraphs without manual prose hard wrapping. Preserve legal/CLA text, provider rights, attribution, diagnostic bytes and intentional Markdown. Use the current [Humanizer guidance](https://github.com/blader/humanizer/blob/main/SKILL.md) for authorized prose rewrites, record its revision in task receipts, and keep project facts and user instructions authoritative. Do not install or execute that repository's scripts.

For docs, forms and label-reference-only changes, use scoped formatting, YAML/schema and producer-reference validation. New automation logic needs causal tests; Node behavior still needs the applicable full verification. Follow [issue triage](docs/issue-triage.md), distinguish source readiness from live taxonomy/native acceptance, and keep live metadata or historical writing within the task's execution scope. Preserve monitoring behavior unless its lifecycle is explicitly in scope.
