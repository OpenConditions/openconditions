#!/usr/bin/env python3
"""Read-only A/B qualification; not host readiness or release approval."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile

SPEC = importlib.util.spec_from_file_location(
    "native", Path(__file__).with_name("trusted-main-image-evidence.py")
)
N = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(N)
require = N.require
TOOLS = Path(__file__).resolve().parent.parent
POLICY = [
    "scripts/product-release-flow.py",
    "scripts/acquire-product-tools.mjs",
    "scripts/bundle-product-release.py",
    ".github/workflows/ci.yml",
    ".github/workflows/product-release.yml",
    ".nvmrc",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/qualify-container-images.py",
    "scripts/trusted-main-image-evidence.py",
    "scripts/check-docker-contexts.mjs",
    "scripts/check-release-inputs.mjs",
    "scripts/qualify-product-inputs.mjs",
    "scripts/qualify-product-release.py",
    "scripts/prepare-product-release.py",
    "scripts/prepare-product-release.mjs",
    "scripts/validate-product-manifests.mjs",
    "scripts/run-openmapx-admission.mjs",
    "scripts/openmapx-product-contracts.json",
    "scripts/fixtures/openmapx-contract-consumer/package.json",
    "scripts/fixtures/openmapx-contract-consumer/pnpm-workspace.yaml",
    "scripts/fixtures/openmapx-contract-consumer/application-lock.yaml",
]


def git(repo, *args):
    return subprocess.check_output(["git", "--no-replace-objects", *args], cwd=repo)


def context(env):
    sha = env.get("GITHUB_SHA", "")
    require(
        env.get("GITHUB_ACTIONS") == "true"
        and env.get("GITHUB_REPOSITORY") == N.REPO
        and env.get("GITHUB_REPOSITORY_ID") == str(N.REPO_ID)
        and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and env.get("GITHUB_REF") == "refs/heads/main"
        and env.get("GITHUB_WORKFLOW_REF")
        == N.REPO + "/.github/workflows/product-release.yml@refs/heads/main"
        and env.get("GITHUB_WORKFLOW_SHA") == sha
        and re.fullmatch(r"[a-f0-9]{40}", sha),
        "untrusted qualification context",
    )
    return sha


def history(api):
    result = {}
    for endpoint in ["releases", "tags"]:
        items = []
        for page in range(1, 11):
            chunk = api.json(f"{N.PREFIX}/{endpoint}?per_page=100&page={page}")
            require(
                isinstance(chunk, list) and len(chunk) <= 100,
                "malformed version history",
            )
            items.extend(chunk)
            if len(chunk) < 100:
                break
        else:
            raise ValueError("version history exceeds bounded inventory")
        result[endpoint] = sorted(
            [
                item["tag_name"] if endpoint == "releases" else item["name"]
                for item in items
            ]
        )
    require(result["tags"], "absent tag history")
    return result


def latest_manifest(api, source, run_id, attempt, clock):
    selected = api.json(
        f"{N.PREFIX}/actions/workflows/ci.yml/runs?head_sha={source}&event=push&per_page=100&page=1"
    )
    runs = selected.get("workflow_runs")
    require(
        isinstance(runs, list)
        and len(runs) == selected.get("total_count")
        and 0 < len(runs) <= 100,
        "incomplete main run inventory",
    )
    require(
        all(
            x.get("head_sha") == source
            and x.get("event") == "push"
            and N.positive(x.get("id"))
            for x in runs
        ),
        "wrong main run selection",
    )
    require(
        max(x["id"] for x in runs) == run_id, "B run is not latest exact-source push"
    )
    producer, jobs = N.inspect_run(api, source, run_id, attempt, clock(), True)
    require(producer["event"] == "push", "B must be a completed main push")
    return {
        "source": source,
        "producer": producer,
        "coverage": [
            {
                k: job[k]
                for k in [
                    "id",
                    "name",
                    "run_id",
                    "head_sha",
                    "status",
                    "conclusion",
                    "started_at",
                    "completed_at",
                ]
            }
            for job in jobs.values()
        ],
    }


def policy(repo, tool_source, image_source):
    for path in POLICY:
        trusted = git(repo, "show", f"{tool_source}:{path}")
        require(
            trusted == N.Q.regular(TOOLS / path),
            "checked-out trusted tool bytes differ",
        )
        require(
            trusted == git(repo, "show", f"{image_source}:{path}"),
            "image policy differs from current trusted policy",
        )


def snapshot_image_artifacts(api, native, source, run_id):
    snapshots = {}
    for ref in [native["candidateArtifact"], *native["imageArtifacts"].values()]:
        fresh = api.json(f"{N.PREFIX}/actions/artifacts/{ref['id']}")
        require(
            all(
                fresh.get(key) == ref[value]
                for key, value in [
                    ("digest", "digest"),
                    ("size_in_bytes", "sizeBytes"),
                    ("expires_at", "expiresAt"),
                    ("created_at", "createdAt"),
                    ("name", "name"),
                ]
            )
            and fresh.get("expired") is False
            and fresh.get("workflow_run", {}).get("head_sha") == source
            and fresh["workflow_run"].get("id") == run_id,
            "A artifact identity changed",
        )
        snapshots[ref["id"]] = fresh
    return snapshots


def owning_checkout(repo):
    require(
        git(repo, "remote", "get-url", "origin").decode().strip()
        in [
            "https://github.com/OpenConditions/openconditions.git",
            "https://github.com/OpenConditions/openconditions",
            "git@github.com:OpenConditions/openconditions.git",
        ],
        "wrong checkout origin",
    )


def qualify(
    api,
    repo,
    tool_source,
    image_source,
    manifest_source,
    image_run,
    image_attempt,
    manifest_run,
    manifest_attempt,
    version,
    *,
    clock=None,
):
    native_now = None if clock is None else clock()
    clock = clock or (lambda: datetime.now(timezone.utc))
    require(
        all(
            re.fullmatch(r"[a-f0-9]{40}", value)
            for value in [tool_source, image_source, manifest_source]
        ),
        "immutable sources required",
    )
    owning_checkout(repo)
    for ancestor, descendant in [
        (image_source, manifest_source),
        (manifest_source, tool_source),
    ]:
        subprocess.run(
            [
                "git",
                "--no-replace-objects",
                "merge-base",
                "--is-ancestor",
                ancestor,
                descendant,
            ],
            cwd=repo,
            check=True,
            capture_output=True,
        )
    policy(repo, tool_source, image_source)
    main = api.json(N.PREFIX + "/git/ref/heads/main")
    require(
        main.get("object", {}).get("sha") == tool_source,
        "trusted main advanced before qualification",
    )
    native = N.validate(api, image_source, image_run, image_attempt, now=native_now)
    artifact_before = snapshot_image_artifacts(api, native, image_source, image_run)
    b = latest_manifest(api, manifest_source, manifest_run, manifest_attempt, clock)
    require(
        b["producer"]["workflowSourceBlobSha"]
        == hashlib.sha1(
            b"blob "
            + str(len(git(repo, "show", f"{manifest_source}:{N.WORKFLOW}"))).encode()
            + b"\0"
            + git(repo, "show", f"{manifest_source}:{N.WORKFLOW}")
        ).hexdigest(),
        "B workflow API/source mismatch",
    )
    require(
        native["producer"]["workflowSourceBlobSha"]
        == b["producer"]["workflowSourceBlobSha"]
        and native["producer"]["workflowSourceSha256"]
        == b["producer"]["workflowSourceSha256"],
        "A/B native workflow policy differs",
    )
    versions = history(api)
    candidate = {
        "schemaVersion": 1,
        "version": version,
        "imageSourceSha": image_source,
        "producer": {
            "workflowFile": N.WORKFLOW,
            "runId": image_run,
            "runAttempt": image_attempt,
        },
        "images": native["images"],
    }
    with tempfile.TemporaryDirectory(prefix="oc-product-inputs-") as temporary:
        inputs = Path(temporary) / "inputs.json"
        inputs.write_bytes(
            N.canonical(
                {
                    "repo": str(repo),
                    "imageSource": image_source,
                    "releaseSource": manifest_source,
                    "version": version,
                    "producerInputs": candidate,
                    "history": versions["tags"] + versions["releases"],
                }
            )
        )
        result = subprocess.run(
            ["node", str(TOOLS / "scripts/qualify-product-inputs.mjs"), str(inputs)],
            cwd=repo,
            capture_output=True,
            timeout=900,
            check=False,
        )
        require(
            result.returncode == 0,
            "A/B metadata or effective-context validation failed: "
            + result.stderr.decode(errors="replace")[-8000:],
        )
        proof = N.Q.decode(result.stdout)
    require(
        proof["contexts"] != "NOT_CHECKED" and proof["contexts"]["equal"] is True,
        "context proof unavailable",
    )
    require(
        proof["imageSource"] == image_source
        and proof["releaseSource"] == manifest_source
        and proof["candidate"] == candidate,
        "input proof identity mismatch",
    )
    # Native B/main/history/artifact rereads are independent of candidate data.
    require(
        latest_manifest(api, manifest_source, manifest_run, manifest_attempt, clock)
        == b,
        "B authority changed",
    )
    require(
        api.json(N.PREFIX + "/git/ref/heads/main") == main and history(api) == versions,
        "main/history changed",
    )
    refs = [native["candidateArtifact"], *native["imageArtifacts"].values()]
    for ref in refs:
        fresh = api.json(f"{N.PREFIX}/actions/artifacts/{ref['id']}")
        require(
            fresh == artifact_before[ref["id"]]
            and N.timestamp(ref["expiresAt"]) > clock(),
            "A artifact changed/expired at completion",
        )
    stable_a, _ = N.inspect_run(
        api, image_source, image_run, image_attempt, clock(), True
    )
    require(stable_a == native["producer"], "A authority changed")
    policy(repo, tool_source, image_source)
    paths = [
        "extension.json",
        *[
            f"services/{name}/service.json"
            for name in ["ingest", "ingest-heavy", "contributions-api", "federation"]
        ],
        f"docs/release-notes/{version}.json",
        f"docs/release-notes/{version}.md",
    ]
    receipt = {
        "schemaVersion": 1,
        "kind": "OpenConditions product qualification only",
        "version": version,
        "imageSourceSha": image_source,
        "manifestSourceSha": manifest_source,
        "tagTargetSha": manifest_source,
        "imageEvidence": native,
        "manifestEvidence": b,
        "manifestSha256": {
            path: N.Q.sha(git(repo, "show", f"{manifest_source}:{path}"))
            for path in paths
        },
        "contextProof": proof["contexts"],
        "historySha256": N.Q.sha(N.canonical(versions)),
        "eligibleUntil": native["eligibleUntil"],
        "releaseAuthority": False,
        "downstream": {
            key: "NOT_IMPLEMENTED"
            for key in [
                "hostAdmission",
                "stagingReadiness",
                "approval",
                "immutability",
                "publication",
                "channels",
            ]
        },
    }
    validate_receipt(receipt)
    return receipt


def validate_receipt(value):
    """Exact v1 artifact shape. This schema does not confer native authority."""

    def keys(item, expected):
        require(
            type(item) is dict and set(item) == set(expected.split()),
            "unknown/missing receipt fields",
        )

    def producer(item):
        keys(
            item,
            "repository repositoryId workflowFile workflowId runId runAttempt event workflowSourceBlobSha workflowSourceSha256",
        )
        require(
            item["repository"] == N.REPO
            and item["repositoryId"] == N.REPO_ID
            and item["workflowId"] == N.WORKFLOW_ID
            and item["workflowFile"] == "ci.yml",
            "receipt producer identity mismatch",
        )
        require(
            N.positive(item["runId"])
            and N.positive(item["runAttempt"])
            and item["event"] in ["push", "workflow_dispatch"],
            "invalid receipt run",
        )

    def artifact(item):
        keys(item, "id name digest sizeBytes createdAt expiresAt")
        require(
            N.positive(item["id"])
            and N.positive(item["sizeBytes"])
            and N.Q.DIGEST.fullmatch(item["digest"]),
            "invalid receipt artifact",
        )
        require(
            N.timestamp(item["createdAt"]) < N.timestamp(item["expiresAt"]),
            "invalid receipt expiry",
        )

    keys(
        value,
        "schemaVersion kind version imageSourceSha manifestSourceSha tagTargetSha imageEvidence manifestEvidence manifestSha256 contextProof historySha256 eligibleUntil releaseAuthority downstream",
    )
    require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["kind"] == "OpenConditions product qualification only"
        and value["releaseAuthority"] is False,
        "invalid receipt authority",
    )
    require(
        value["tagTargetSha"] == value["manifestSourceSha"]
        and all(
            re.fullmatch(r"[a-f0-9]{40}", value[key])
            for key in ["imageSourceSha", "manifestSourceSha"]
        ),
        "invalid receipt sources",
    )
    require(
        value["downstream"]
        == {
            key: "NOT_IMPLEMENTED"
            for key in [
                "hostAdmission",
                "stagingReadiness",
                "approval",
                "immutability",
                "publication",
                "channels",
            ]
        },
        "unsupported downstream acceptance",
    )
    a = value["imageEvidence"]
    keys(
        a,
        "schemaVersion buildSourceSha producer candidateArtifact imageArtifacts images eligibleUntil releaseAuthority",
    )
    require(
        a["buildSourceSha"] == value["imageSourceSha"]
        and a["releaseAuthority"] is False
        and a["schemaVersion"] == 1,
        "invalid image receipt binding",
    )
    producer(a["producer"])
    artifact(a["candidateArtifact"])
    for item in [a["images"], a["imageArtifacts"]]:
        keys(item, " ".join(N.Q.IMAGES))
    for role, image in a["images"].items():
        keys(
            image,
            "repository digest platforms buildSourceSha qualificationArtifactId sbomArtifactId provenanceArtifactId",
        )
        artifact(a["imageArtifacts"][role])
        require(
            image["repository"] == "ghcr.io/openconditions/" + role
            and N.Q.DIGEST.fullmatch(image["digest"])
            and image["platforms"] == ["linux/amd64"]
            and image["buildSourceSha"] == value["imageSourceSha"],
            "invalid receipt image",
        )
        require(
            image["qualificationArtifactId"]
            == image["sbomArtifactId"]
            == a["imageArtifacts"][role]["id"]
            and image["provenanceArtifactId"] == a["candidateArtifact"]["id"],
            "invalid receipt artifact binding",
        )
    b = value["manifestEvidence"]
    keys(b, "source producer coverage")
    producer(b["producer"])
    require(
        b["source"] == value["manifestSourceSha"] and b["producer"]["event"] == "push",
        "invalid manifest receipt",
    )
    require(
        len(b["coverage"]) == len(N.GATES) + 1
        and {j["name"] for j in b["coverage"]} == {*N.GATES, N.PRODUCER_JOB},
        "invalid receipt coverage",
    )
    for job in b["coverage"]:
        keys(job, "id name run_id head_sha status conclusion started_at completed_at")
        require(
            N.positive(job["id"])
            and job["run_id"] == b["producer"]["runId"]
            and job["head_sha"] == b["source"]
            and job["status"] == "completed"
            and job["conclusion"] == "success",
            "invalid receipt job",
        )
    paths = {
        "extension.json",
        *[
            f"services/{name}/service.json"
            for name in ["ingest", "ingest-heavy", "contributions-api", "federation"]
        ],
        *[
            f"docs/release-notes/{value['version']}.{suffix}"
            for suffix in ["json", "md"]
        ],
    }
    require(
        set(value["manifestSha256"]) == paths
        and all(
            re.fullmatch(r"[a-f0-9]{64}", digest)
            for digest in value["manifestSha256"].values()
        ),
        "invalid manifest hash binding",
    )
    proof = value["contextProof"]
    keys(proof, "schemaVersion imageSource releaseSource equal images")
    require(
        proof["equal"] is True
        and proof["imageSource"] == value["imageSourceSha"]
        and proof["releaseSource"] == value["manifestSourceSha"]
        and len(proof["images"]) == 4,
        "invalid context receipt",
    )
    require(
        proof["schemaVersion"] == 1
        and [i["image"] for i in proof["images"]] == list(N.Q.IMAGES),
        "invalid context image set",
    )
    for image in proof["images"]:
        keys(image, "image context recipe a b differences")
        require(
            image["differences"] == []
            and image["context"] == N.Q.IMAGES[image["image"]][0]
            and image["recipe"] == f"services/{image['image']}/Dockerfile",
            "invalid context binding",
        )
        for side in ["a", "b"]:
            summary = image[side]
            keys(
                summary, "files inventory inventorySha256 ignore ignoreSha256 buildRef"
            )
            require(
                summary["files"] == len(summary["inventory"])
                and isinstance(summary["buildRef"], str)
                and summary["buildRef"],
                "invalid context inventory",
            )
            for entry in summary["inventory"]:
                keys(entry, "path mode sha256")
                require(
                    entry["mode"] in [0o644, 0o755]
                    and isinstance(entry["path"], str)
                    and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]),
                    "invalid context entry",
                )
        require(
            image["a"]["inventory"] == image["b"]["inventory"], "context entries differ"
        )
    require(
        value["eligibleUntil"] == a["eligibleUntil"]
        and re.fullmatch(r"[a-f0-9]{64}", value["historySha256"]),
        "invalid receipt lifetime/history",
    )


def main():
    tool_source = context(os.environ)  # Reject context before reading credentials.
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["image-source", "manifest-source", "version"]:
        parser.add_argument("--" + name, required=True)
    for name in ["image-run", "image-attempt", "manifest-run", "manifest-attempt"]:
        parser.add_argument("--" + name, type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(
        not args.output.exists() and not args.output.is_symlink(), "output must be new"
    )
    result = qualify(
        N.Github(os.environ.get("GH_TOKEN", "")),
        Path.cwd(),
        tool_source,
        args.image_source,
        args.manifest_source,
        args.image_run,
        args.image_attempt,
        args.manifest_run,
        args.manifest_attempt,
        args.version,
    )
    with args.output.open("xb") as stream:
        stream.write(N.canonical(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Product qualification failed",
            file=__import__("sys").stderr,
        )
        raise SystemExit(1) from None
