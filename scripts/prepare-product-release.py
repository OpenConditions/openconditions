#!/usr/bin/env python3
"""Native A preparation binding, owned output only. No GitHub or host mutations."""

import argparse
import importlib.util
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

# Read-only preparation must not create module caches in the caller checkout.
sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location(
    "product", Path(__file__).with_name("qualify-product-release.py")
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
N = P.N


def prepare(
    api,
    repo,
    tool_source,
    image_source,
    run_id,
    attempt,
    version,
    notes,
    output,
    tools,
    *,
    now=None,
):
    N.require(
        all(
            re.fullmatch(r"[a-f0-9]{40}", value)
            for value in [tool_source, image_source]
        ),
        "immutable sources required",
    )
    P.owning_checkout(repo)
    output = output.absolute()
    N.require(
        not output.exists()
        and not output.is_symlink()
        and not Path(str(output) + ".receipt.json").exists(),
        "output/receipt must be new",
    )
    N.require(
        repo.resolve() not in output.resolve().parents
        and output.resolve() != repo.resolve(),
        "output must be outside caller worktree",
    )
    subprocess.run(
        [
            "git",
            "--no-replace-objects",
            "merge-base",
            "--is-ancestor",
            image_source,
            tool_source,
        ],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    P.policy(repo, tool_source, image_source)
    main = api.json(N.PREFIX + "/git/ref/heads/main")
    N.require(main.get("object", {}).get("sha") == tool_source, "trusted main advanced")
    native = N.validate(api, image_source, run_id, attempt, now=now)
    clock = (lambda: now) if now is not None else (lambda: datetime.now(timezone.utc))
    versions = P.history(api)
    producer = {
        "schemaVersion": 1,
        "version": version,
        "imageSourceSha": image_source,
        "producer": {
            "workflowFile": N.WORKFLOW,
            "runId": run_id,
            "runAttempt": attempt,
        },
        "images": native["images"],
    }
    artifacts = P.snapshot_image_artifacts(api, native, image_source, run_id)
    with tempfile.TemporaryDirectory(prefix="oc-native-preparation-") as temporary:
        work = Path(temporary)
        inputs = work / "inputs.json"
        inputs.write_bytes(
            N.canonical(
                {
                    "imageSource": image_source,
                    "version": version,
                    "producerInputs": producer,
                    "history": versions["tags"] + versions["releases"],
                }
            )
        )
        staged = work / "prepared"
        result = subprocess.run(
            [
                "node",
                str(P.TOOLS / "scripts/prepare-product-release.mjs"),
                "--inputs",
                str(inputs),
                "--notes",
                str(notes),
                "--output",
                str(staged),
                "--tools",
                str(tools),
            ],
            cwd=repo,
            capture_output=True,
            timeout=900,
        )
        N.require(
            result.returncode == 0,
            "Owned preparation rejected: "
            + result.stderr.decode(errors="replace")[-8000:],
        )
        proof = N.Q.json_file(Path(str(staged) + ".receipt.json"))
        N.require(
            proof["nativeAuthority"] is False
            and proof["releaseAuthority"] is False
            and proof["imageSourceSha"] == image_source
            and proof["version"] == version
            and proof["contextProof"]["equal"] is True,
            "invalid local preparation binding",
        )
        for identity, before in artifacts.items():
            N.require(
                api.json(f"{N.PREFIX}/actions/artifacts/{identity}") == before
                and before.get("expired") is False
                and N.timestamp(before["expires_at"]) > clock(),
                "A artifact changed/expired",
            )
        stable, _ = N.inspect_run(api, image_source, run_id, attempt, clock(), True)
        N.require(
            stable == native["producer"]
            and P.history(api) == versions
            and api.json(N.PREFIX + "/git/ref/heads/main") == main,
            "native policy/history/source changed",
        )
        P.policy(repo, tool_source, image_source)
        receipt = {
            "schemaVersion": 1,
            "kind": "Native A preparation binding only",
            "nativeImageEvidence": native,
            "localProof": proof,
            "releaseAuthority": False,
            "nativeBQualified": False,
            "eligibleUntil": native["eligibleUntil"],
        }
        output.mkdir()
        try:
            for path, digest in proof["metadataSha256"].items():
                data = N.Q.regular(staged / path)
                N.require(N.Q.sha(data) == digest, "prepared file changed")
                target = output / path
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as stream:
                    stream.write(data)
                target.chmod(0o644)
            with Path(str(output) + ".receipt.json").open("xb") as stream:
                stream.write(N.canonical(receipt))
        except Exception:
            shutil.rmtree(output)
            raise
    return receipt


def main():
    source = P.context(
        os.environ
    )  # Same trusted main/manual read-only context; no active prepare job yet.
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["image-source", "version"]:
        parser.add_argument("--" + name, required=True)
    for name in ["image-run", "image-attempt"]:
        parser.add_argument("--" + name, type=int, required=True)
    for name in ["notes", "output", "tools"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    prepare(
        N.Github(os.environ.get("GH_TOKEN", "")),
        Path.cwd(),
        source,
        args.image_source,
        args.image_run,
        args.image_attempt,
        args.version,
        args.notes,
        args.output,
        args.tools,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Native preparation failed",
            file=__import__("sys").stderr,
        )
        raise SystemExit(1) from None
