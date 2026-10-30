#!/usr/bin/env python3
"""CI prepare/review. No publication or fabricated readiness authority."""

import argparse
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "bundle", Path(__file__).with_name("bundle-product-release.py")
)
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)
P, N, Q = B.P, B.N, B.Q
SPEC2 = importlib.util.spec_from_file_location(
    "prepare", Path(__file__).with_name("prepare-product-release.py")
)
PREP = importlib.util.module_from_spec(SPEC2)
SPEC2.loader.exec_module(PREP)


def discover(api, source, clock):
    data = api.json(
        f"{N.PREFIX}/actions/workflows/ci.yml/runs?head_sha={source}&event=push&per_page=100&page=1"
    )
    runs = data.get("workflow_runs")
    N.require(
        type(runs) is list
        and len(runs) == data.get("total_count")
        and 0 < len(runs) <= 100,
        "No complete exact-source CI inventory; wait for owning main CI",
    )
    N.require(
        all(
            x.get("head_sha") == source
            and x.get("event") == "push"
            and N.positive(x.get("id"))
            for x in runs
        ),
        "Wrong exact-source main producer inventory",
    )
    selected = max(runs, key=lambda x: x["id"])
    N.require(
        selected.get("status") == "completed"
        and selected.get("conclusion") == "success"
        and N.positive(selected.get("run_attempt")),
        "Latest exact main CI is pending/failed; inspect CI, do not use an older green run",
    )
    P.latest_manifest(api, source, selected["id"], selected["run_attempt"], clock)
    return selected["id"], selected["run_attempt"]


def summary(operation, version, source, artifact, blocked=None):
    validation = "not verified" if blocked else "verified"
    return f"""# Product {operation}: {version}

Source: `{source}`

{("**Blocked:** " + blocked) if blocked else "**Review artifact prepared. This is not release approval.**"}

- Tests and images: {validation} (exact owning-main gates and four-image evidence).
- Manifest compatibility: {validation} (pointer/context checks and actual pinned CLI/admission).
- Evidence: {artifact}
- Readiness: **pending** installation, configuration/health, rights/privacy fixtures, prior-deployment upgrade/migration, backup/restore/recovery and optional federation/TUF evidence.
- Publication: **blocked**; trusted readiness producer, protected approval and promotion are not implemented.
- Next: {"resolve the blocker and run this operation again" if blocked else ("open the preparation PR link from the preparation-pr job, review notes and required checks" if operation == "prepare" else "review exact A/B qualification and artifact; operational rehearsal remains separate")}.

No run IDs, image digests or passing readiness JSON need to be transcribed. No tag, release, registry or host mutation occurred.
"""


def versioned_notes(version, notes):
    return f"""# Product {version}

Affected versions: Proposed product {version}; not yet published.

Action: Review this preparation and the notes below before release. Operational rehearsal and publication approval remain separate.

Compatibility: This preparation changes metadata only relative to its image source A. Release-specific compatibility and migration details belong in the reviewed notes below.

Caveats: No live installation, upgrade, recovery or readiness acceptance is implied by preparation.

## Reviewed notes

{notes}
"""


def execute(api, repo, source, operation, version, notes, tools, output, clock=None):
    fixture_now = None if clock is None else clock()
    clock = clock or (lambda: datetime.now(timezone.utc))
    N.require(operation in ["prepare", "review"], "Unsupported operation")
    run, attempt = discover(api, source, clock)
    if operation == "prepare":
        N.require(
            isinstance(notes, str) and notes.strip(),
            "Reviewed release notes required for preparation",
        )
        with tempfile.TemporaryDirectory(prefix="oc-release-notes-") as temp:
            path = Path(temp) / "notes.md"
            path.write_text(versioned_notes(version, notes))
            return PREP.prepare(
                api,
                repo,
                source,
                source,
                run,
                attempt,
                version,
                path,
                output,
                tools,
                now=fixture_now,
            )
    # Select A from passive committed candidate metadata, never candidate commands.
    N.require(
        isinstance(version, str)
        and "/" not in version
        and "\\" not in version
        and version not in [".", ".."],
        "Unsupported version path",
    )
    candidate = Q.decode(
        P.git(repo, "show", f"{source}:docs/release-notes/{version}.json")
    )
    q = P.qualify(
        api,
        repo,
        source,
        candidate["imageSourceSha"],
        source,
        candidate["producer"]["runId"],
        candidate["producer"]["runAttempt"],
        run,
        attempt,
        version,
        clock=clock,
    )
    return B.assemble(
        api,
        repo,
        q,
        None,
        output,
        tools,
        clock=clock,
        before_emit=lambda: B.final_native_fences(api, repo, q, source, clock),
    )


def main():
    source = P.context(os.environ)  # Before credentials, local files or candidate code.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tools", type=Path)
    args = parser.parse_args()
    operation = os.environ.get("RELEASE_OPERATION", "")
    version = os.environ.get("RELEASE_VERSION", "")
    notes = os.environ.get("RELEASE_NOTES", "")
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    try:
        if args.check_only:
            discover(
                N.Github(os.environ.get("GH_TOKEN", "")),
                source,
                lambda: datetime.now(timezone.utc),
            )
            return
        N.require(
            args.output is not None and args.tools is not None,
            "Owned output/tools are required internally",
        )
        execute(
            N.Github(os.environ.get("GH_TOKEN", "")),
            Path.cwd(),
            source,
            operation,
            version,
            notes,
            args.tools,
            args.output,
        )
    except Exception:
        if target:
            Path(target).write_text(
                summary(
                    operation,
                    version,
                    source,
                    "No eligible artifact",
                    "Exact owning CI/artifact/metadata validation failed; inspect the diagnostic log.",
                )
            )
        raise
    if target:
        Path(target).write_text(
            summary(
                operation,
                version,
                source,
                "Actions → this run → product-review artifact",
            )
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Product review failed; no publication performed",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
