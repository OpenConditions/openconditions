#!/usr/bin/env python3
"""One maintainer workflow: prepare a PR, review tested assets, explicitly publish."""

import argparse
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(name + "-product-release.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load("qualify")
PREP = load("prepare")
R = load("rehearse")
PUB = load("publish")
N, Q = P.N, P.N.Q


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


def versioned_notes(version, notes):
    return f"# Product {version}\n\n{notes.strip()}\n"


def summary(operation, version, source, blocked=None):
    return f"""# Product {operation}: {version}

Source: `{source}`

{("Blocked: " + blocked) if blocked else "Tests, original image evidence and manifest compatibility verified."}

- Prepare: review the linked preparation PR and merge it normally.
- Review: inspect the Actions artifact, bounded installation/recovery and rights/privacy results.
- Publish: explicit intent, followed by one native product-release environment approval. No rebuild during promotion; preview updates last.
- Not exercised: production upgrade, optional federation/TUF, live providers or other platforms. No production certification is implied.

No run IDs, digests, local paths or passing JSON are operator inputs.
"""


def execute(
    api, repo, source, operation, version, notes, tools, output, clock=None, rights=None
):
    fixture_now = None if clock is None else clock()
    clock = clock or (lambda: datetime.now(timezone.utc))
    N.require(operation in ["prepare", "review", "publish"], "unsupported operation")
    run, attempt = discover(api, source, clock)
    if operation == "prepare":
        N.require(
            isinstance(notes, str) and notes.strip(), "Reviewed release notes required"
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
    N.require(
        isinstance(version, str)
        and "/" not in version
        and "\\" not in version
        and version not in [".", ".."],
        "invalid version path",
    )
    candidate = Q.decode(
        P.git(repo, "show", f"{source}:docs/release-notes/{version}.json")
    )
    with tempfile.TemporaryDirectory(
        prefix="oc-product-review-", dir=output.parent
    ) as temp:
        work = Path(temp)
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
            image_directory=work / "images",
            resume=True,
        )
        rehearsal = R.run(
            api,
            repo,
            q,
            output.with_name(output.name + "-rehearsal"),
            clock=clock,
            image_directory=work / "images",
            resume=True,
        )
        # Actual pinned portable CLI/admission, using passive committed metadata.
        staged = work / "manifests"
        staged.mkdir()
        for path in q["manifestSha256"]:
            file = staged / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(P.git(repo, "show", f"{source}:{path}"))
        checked = subprocess.run(
            [
                "node",
                str(P.TOOLS / "scripts/validate-product-manifests.mjs"),
                str(staged),
                str(tools),
            ],
            capture_output=True,
            timeout=900,
        )
        N.require(
            checked.returncode == 0,
            "portable/admission validation failed: "
            + checked.stderr.decode(errors="replace")[-4000:],
        )
        files = PUB.assets(
            repo, q, work / "images", rehearsal, rights, Q.decode(checked.stdout)
        )
        P.final_fences(api, repo, q, source, clock, resume=True)
        PUB.emit(output, files)
        return q


def main():
    source = P.context(os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tools", type=Path)
    parser.add_argument("--rights-report", type=Path)
    args = parser.parse_args()
    operation = os.environ.get("RELEASE_OPERATION", "")
    version = os.environ.get("RELEASE_VERSION", "")
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    try:
        api = N.Github(os.environ.get("GH_TOKEN", ""))
        if args.check_only:
            discover(api, source, lambda: datetime.now(timezone.utc))
            return
        N.require(
            args.output is not None and args.tools is not None,
            "owned output/tools required",
        )
        execute(
            api,
            Path.cwd(),
            source,
            operation,
            version,
            os.environ.get("RELEASE_NOTES", ""),
            args.tools,
            args.output,
            rights=Q.json_file(args.rights_report)
            if args.rights_report and operation != "prepare"
            else None,
        )
    except Exception:
        if target:
            Path(target).write_text(
                summary(
                    operation,
                    version,
                    source,
                    "Validation failed; inspect the retained diagnostic artifact. No publication attempted.",
                )
            )
        raise
    if target:
        Path(target).write_text(summary(operation, version, source))
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a") as stream:
            stream.write("proof_attempt=" + os.environ["GITHUB_RUN_ATTEMPT"] + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, ValueError)
            else "Product validation failed; no publication attempted"
        ) from None
