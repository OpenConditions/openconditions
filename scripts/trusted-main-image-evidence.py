#!/usr/bin/env python3
"""Read-only trusted-main evidence. No signing, registry or publication authority."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "qualification", Path(__file__).with_name("qualify-container-images.py")
)
Q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(Q)
REPO = "OpenConditions/openconditions"
REPO_ID = 1276024943
WORKFLOW = ".github/workflows/ci.yml"
WORKFLOW_ID = 299994014
PREFIX = f"/repos/{REPO}"
PRODUCER_JOB = "trusted main image evidence"
GATES = [
    "validate CI source",
    "typecheck / test",
    "python lint / test (openlr-resolver)",
    "interop (libtraff, python-tuf)",
    "production dependency audit",
    *[f"image ({role})" for role in Q.IMAGES],
    "container image qualification",
    "required CI",
    "full main qualification",
]
MAX_BYTES = 2 * 1024**3
IMAGE_FILES = {
    "image.oci.tar",
    "identity.json",
    "qualified.json",
    "runtime.json",
    "scan.json",
    "sbom.cdx.json",
    "build-metadata.json",
    "scanner-db.json",
    "build.log",
}
OPTIONAL_FILES = {
    "load.log",
    "scan.json.log",
    "sbom.cdx.json.log",
    "container--db.log",
    "container-app.log",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive(value):
    return type(value) is int and 0 < value < 2**53


def timestamp(value):
    require(isinstance(value, str), "invalid timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.utcoffset() == timedelta(0), "invalid timestamp timezone")
    return result


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Github:
    """Fixed-origin GETs; injected transport is for offline HTTP fixtures only."""

    def __init__(self, token, *, request=None, sleep=time.sleep):
        require(isinstance(token, str) and token, "missing read-only Actions token")
        self.token, self.sleep = token, sleep
        self.deadline = time.monotonic() + 900
        if request is None:
            opener = urllib.request.build_opener(NoRedirect())

            def request(url, headers, timeout):
                try:
                    return opener.open(
                        urllib.request.Request(url, headers=headers), timeout=timeout
                    )
                except urllib.error.HTTPError as error:
                    return error

        self.request = request

    def response(self, url, headers):
        for attempt in range(4):
            require(time.monotonic() < self.deadline, "API assembly deadline exceeded")
            try:
                response = self.request(
                    url, headers, min(30, self.deadline - time.monotonic())
                )
                if response.status not in (429, 500, 502, 503, 504):
                    return response
                response.close()
            except (OSError, urllib.error.URLError):
                pass
            require(attempt < 3, "API GET failed after bounded retries")
            self.sleep(2**attempt)
        raise ValueError("API GET failed")

    def api_response(self, route):
        require(route.startswith(PREFIX + "/") or route == PREFIX, "invalid API route")
        return self.response(
            "https://api.github.com" + route,
            {
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2026-03-10",
                "User-Agent": "OpenConditions-evidence",
            },
        )

    def json(self, route):
        with self.api_response(route) as response:
            require(response.status == 200, "API JSON request failed")
            raw = bytearray()
            while chunk := response.read1(65536):
                require(time.monotonic() < self.deadline, "API JSON deadline exceeded")
                raw.extend(chunk)
                require(len(raw) <= 5 * 1024**2, "API JSON size limit exceeded")
            return Q.decode(raw)

    def pages(self, route, key):
        items = []
        for page in range(1, 11):
            data = self.json(f"{route}?per_page=100&page={page}")
            total = data.get("total_count")
            chunk = data.get(key)
            require(
                type(total) is int
                and 0 <= total <= 1000
                and isinstance(chunk, list)
                and len(chunk) <= 100,
                "API pagination schema/limit failure",
            )
            items.extend(chunk)
            require(len(items) <= total, "API pagination changed")
            if len(items) == total:
                return items
            require(len(chunk) == 100, "API pagination incomplete")
        raise ValueError("API pagination limit exceeded")

    def download(self, artifact, path):
        with self.api_response(
            f"{PREFIX}/actions/artifacts/{artifact['id']}/zip"
        ) as redirect:
            require(redirect.status == 302, "artifact API redirect missing")
            location = redirect.headers.get("Location", "")
            parsed = urllib.parse.urlsplit(location)
            host = parsed.hostname or ""
            require(
                parsed.scheme == "https"
                and not parsed.username
                and not parsed.password
                and parsed.port in (None, 443)
                and not parsed.fragment
                and (
                    host.endswith(".blob.core.windows.net")
                    or host.endswith(".actions.githubusercontent.com")
                ),
                "artifact download origin rejected",
            )
        # The GitHub token is NEVER forwarded to the signed artifact storage URL.
        with self.response(location, {}) as response, path.open("xb") as stream:
            require(response.status == 200, "artifact download failed")
            digest = hashlib.sha256()
            size = 0
            while chunk := response.read1(65536):
                require(
                    time.monotonic() < self.deadline,
                    "artifact transfer deadline exceeded",
                )
                size += len(chunk)
                require(
                    size <= min(MAX_BYTES, artifact["size_in_bytes"]),
                    "artifact size exceeded",
                )
                digest.update(chunk)
                stream.write(chunk)
        require(
            size == artifact["size_in_bytes"]
            and "sha256:" + digest.hexdigest() == artifact["digest"],
            "artifact ZIP hash/size drift",
        )


def producer_context(env):
    require(
        env.get("GITHUB_ACTIONS") == "true"
        and env.get("GITHUB_REPOSITORY") == REPO
        and env.get("GITHUB_REPOSITORY_ID") == str(REPO_ID)
        and env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch")
        and env.get("GITHUB_REF") == "refs/heads/main"
        and env.get("GITHUB_WORKFLOW_REF") == REPO + "/" + WORKFLOW + "@refs/heads/main"
        and re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", ""))
        and env.get("GITHUB_WORKFLOW_SHA") == env.get("GITHUB_SHA"),
        "untrusted producer context",
    )
    values = [env.get(k, "") for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")]
    require(
        all(re.fullmatch(r"[1-9][0-9]*", v) and positive(int(v)) for v in values),
        "invalid producer context IDs",
    )
    return env["GITHUB_SHA"], int(values[0]), int(values[1]), env["GITHUB_EVENT_NAME"]


def step(job, name):
    matches = [s for s in job.get("steps", []) if s.get("name") == name]
    require(
        len(matches) == 1
        and matches[0].get("status") == "completed"
        and matches[0].get("conclusion") == "success",
        "artifact upload/build step failed",
    )
    return matches[0]


def inspect_run(api, source, run_id, attempt, now, completed):
    require(
        re.fullmatch(r"[a-f0-9]{40}", source)
        and positive(run_id)
        and positive(attempt),
        "invalid authority selectors",
    )
    repo = api.json(PREFIX)
    workflow = api.json(PREFIX + "/actions/workflows/ci.yml")
    require(
        repo.get("id") == REPO_ID
        and repo.get("full_name") == REPO
        and repo.get("default_branch") == "main"
        and workflow.get("id") == WORKFLOW_ID
        and workflow.get("path") == WORKFLOW
        and workflow.get("state") == "active",
        "repository/workflow authority mismatch",
    )
    route = f"{PREFIX}/actions/runs/{run_id}"
    current = api.json(route)
    run = api.json(f"{route}/attempts/{attempt}")
    for item in [current, run]:
        require(
            item.get("id") == run_id
            and positive(item.get("run_attempt"))
            and item.get("run_attempt") == attempt
            and item.get("workflow_id") == WORKFLOW_ID
            and item.get("path") == WORKFLOW
            and item.get("event") in ("push", "workflow_dispatch")
            and item.get("head_sha") == source
            and item.get("head_branch") == "main"
            and all(
                item.get(k, {}).get("id") == REPO_ID
                and item.get(k, {}).get("full_name") == REPO
                for k in ("repository", "head_repository")
            ),
            "run authority mismatch",
        )
        require(
            (item.get("status") == "completed" and item.get("conclusion") == "success")
            if completed
            else (
                item.get("status") == "in_progress" and item.get("conclusion") is None
            ),
            "run authority not in eligible state",
        )
    require(
        current["event"] == run["event"]
        and current["run_started_at"] == run["run_started_at"],
        "attempt authority changed",
    )
    started = timestamp(run["run_started_at"])
    require(
        timestamp(run["created_at"]) <= started <= now, "run authority time mismatch"
    )
    jobs = api.pages(f"{route}/attempts/{attempt}/jobs", "jobs")
    require(
        len(jobs) == len(GATES) + 1
        and {j.get("name") for j in jobs} == {*GATES, PRODUCER_JOB}
        and len({j.get("id") for j in jobs}) == len(jobs),
        "missing/unknown/duplicate coverage",
    )
    indexed = {j["name"]: j for j in jobs}
    for name, job in indexed.items():
        require(
            positive(job.get("id"))
            and job.get("run_id") == run_id
            and job.get("head_sha") == source,
            "coverage job authority mismatch",
        )
        require(
            started <= timestamp(job["started_at"]) <= now, "coverage start mismatch"
        )
        if name == PRODUCER_JOB and not completed:
            require(
                job.get("status") == "in_progress" and job.get("conclusion") is None,
                "producer coverage mismatch",
            )
        else:
            require(
                job.get("status") == "completed" and job.get("conclusion") == "success",
                "coverage did not complete successfully",
            )
            require(
                timestamp(job["started_at"]) <= timestamp(job["completed_at"]) <= now,
                "coverage completion mismatch",
            )
    if completed:
        step(indexed[PRODUCER_JOB], "Retain trusted-main candidate evidence")
    content = api.json(PREFIX + "/contents/" + WORKFLOW + "?ref=" + source)
    require(
        content.get("type") == "file"
        and content.get("path") == WORKFLOW
        and content.get("encoding") == "base64",
        "workflow source authority mismatch",
    )
    raw = base64.b64decode(content["content"], validate=False)
    oid = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    require(content.get("sha") == oid, "workflow source authority hash mismatch")
    producer = {
        "repository": REPO,
        "repositoryId": REPO_ID,
        "workflowFile": "ci.yml",
        "workflowId": WORKFLOW_ID,
        "runId": run_id,
        "runAttempt": attempt,
        "event": run["event"],
        "workflowSourceBlobSha": oid,
        "workflowSourceSha256": Q.sha(raw),
    }
    return producer, indexed


def artifact_reference(api, artifact, producer, job, upload_step, now):
    require(positive(artifact.get("id")), "invalid artifact ID")
    fresh = api.json(f"{PREFIX}/actions/artifacts/{artifact['id']}")
    require(fresh == artifact, "artifact API metadata drift")
    source = producer["source"]
    run = artifact.get("workflow_run", {})
    require(
        run.get("id") == producer["runId"]
        and run.get("repository_id") == REPO_ID
        and run.get("head_repository_id") == REPO_ID
        and run.get("head_branch") == "main"
        and run.get("head_sha") == source
        and artifact.get("expired") is False
        and positive(artifact.get("size_in_bytes"))
        and artifact["size_in_bytes"] <= MAX_BYTES
        and isinstance(artifact.get("digest"), str)
        and Q.DIGEST.fullmatch(artifact["digest"]),
        "artifact authority/identity mismatch",
    )
    created, expires = (timestamp(artifact[k]) for k in ("created_at", "expires_at"))
    upload = step(job, upload_step)
    require(
        timestamp(job["started_at"])
        <= timestamp(upload["started_at"])
        <= created
        <= timestamp(upload["completed_at"])
        <= timestamp(job["completed_at"])
        <= now
        and created <= now < expires <= created + timedelta(days=3),
        "artifact expired/retention/attempt time mismatch",
    )
    return {
        "id": artifact["id"],
        "name": artifact["name"],
        "digest": artifact["digest"],
        "sizeBytes": artifact["size_in_bytes"],
        "createdAt": artifact["created_at"],
        "expiresAt": artifact["expires_at"],
    }


def unpack(path, destination, required, optional):
    destination.mkdir()
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = [i.filename for i in entries]
            require(
                set(names).issuperset(required)
                and set(names) <= required | optional
                and len(names) == len(set(names))
                and sum(i.file_size for i in entries) <= MAX_BYTES,
                "artifact ZIP missing/duplicate/unexpected members",
            )
            for info in entries:
                mode = info.external_attr >> 16
                limit = (
                    MAX_BYTES
                    if info.filename == "image.oci.tar"
                    else 16 * 1024**2
                    if info.filename.endswith(".json")
                    else 32 * 1024**2
                )
                require(
                    not info.is_dir()
                    and (not stat.S_IFMT(mode) or stat.S_ISREG(mode))
                    and info.file_size <= limit,
                    "artifact ZIP has nonregular members",
                )
                with (
                    archive.open(info) as source,
                    (destination / info.filename).open("xb") as target,
                ):
                    size = 0
                    while chunk := source.read(1024**2):
                        size += len(chunk)
                        require(
                            size <= info.file_size,
                            "artifact ZIP expansion limit exceeded",
                        )
                        target.write(chunk)
                    require(size == info.file_size, "artifact ZIP incomplete member")
    except (zipfile.BadZipFile, OSError) as error:
        raise ValueError("artifact ZIP could not be validated") from error


def recheck_artifacts(api, artifacts, clock):
    for artifact in artifacts:
        require(
            api.json(f"{PREFIX}/actions/artifacts/{artifact['id']}") == artifact
            and artifact["expired"] is False
            and timestamp(artifact["expires_at"]) > clock(),
            "artifact disappeared/changed/expired during validation",
        )


def documents(api, source, run_id, attempt, work, clock, completed):
    producer, jobs = inspect_run(api, source, run_id, attempt, clock(), completed)
    artifacts = api.pages(f"{PREFIX}/actions/runs/{run_id}/artifacts", "artifacts")
    require(
        len({a.get("id") for a in artifacts}) == len(artifacts),
        "duplicate artifact IDs",
    )
    selected = [
        a
        for a in artifacts
        if a.get("name", "").startswith("image-") and a["name"].endswith(f"-{attempt}")
    ]
    expected = {f"image-{role}-{attempt}" for role in Q.IMAGES}
    require(
        len(selected) == 4 and {a["name"] for a in selected} == expected,
        "missing/duplicate/unexpected image artifact set",
    )
    coverage = [
        {
            k: jobs[name][k]
            for k in ("id", "name", "started_at", "completed_at", "conclusion")
        }
        for name in GATES
    ]
    images, files, expiries = {}, {}, []
    for role in Q.IMAGES:
        artifact = next(a for a in selected if a["name"] == f"image-{role}-{attempt}")
        job = jobs[f"image ({role})"]
        step(job, "Build, smoke, scan and bind image evidence")
        reference = artifact_reference(
            api,
            artifact,
            {**producer, "source": source},
            job,
            "Retain qualification or failure evidence",
            clock(),
        )
        archive, directory = work / f"{role}.zip", work / role
        api.download(artifact, archive)
        require(
            timestamp(reference["expiresAt"]) > clock(),
            "artifact expired during transfer",
        )
        unpack(archive, directory, IMAGE_FILES, OPTIONAL_FILES)
        result = Q.verify_reports(
            directory,
            role,
            source,
            {"kind": "github", "runId": run_id, "attempt": attempt},
        )
        require(
            Q.json_file(directory / "qualified.json") == result,
            "forged qualification receipt",
        )
        require(
            api.json(f"{PREFIX}/actions/artifacts/{artifact['id']}") == artifact,
            "artifact changed during validation",
        )
        provenance = {
            "schemaVersion": 1,
            "kind": "OpenConditions image producer receipt",
            "buildSourceSha": source,
            "producer": producer,
            "qualificationArtifact": reference,
            "qualification": result,
            "buildLogSha256": Q.sha(Q.regular(directory / "build.log")),
            "signedAttestation": False,
            "registryAuthority": False,
        }
        name = f"{role}.provenance.json"
        files[name] = canonical(provenance)
        images[role] = {
            "repository": "ghcr.io/openconditions/" + role,
            "digest": result["identity"]["platformManifestDigest"],
            "platforms": [result["identity"]["platform"]],
            "buildSourceSha": source,
            "qualificationArtifactId": artifact["id"],
            "sbomArtifactId": artifact["id"],
            "qualificationArtifact": reference,
            "provenanceFile": name,
            "provenanceSha256": Q.sha(files[name]),
        }
        expiries.append(reference["expiresAt"])
    recheck_artifacts(api, selected, clock)
    stable, stable_jobs = inspect_run(api, source, run_id, attempt, clock(), completed)
    require(
        stable == producer and all(stable_jobs[n] == jobs[n] for n in GATES),
        "source authority/coverage changed during assembly",
    )
    require(min(map(timestamp, expiries)) > clock(), "artifact expired during assembly")
    files["candidate.json"] = canonical(
        {
            "schemaVersion": 1,
            "buildSourceSha": source,
            "producer": producer,
            "coverage": coverage,
            "eligibleUntil": min(expiries, key=timestamp),
            "images": images,
            "releaseAuthority": False,
        }
    )
    return files, artifacts, producer, jobs


def assemble(api, env, output, *, now=None):
    source, run_id, attempt, event = producer_context(env)
    clock = (lambda: datetime.now(timezone.utc)) if now is None else (lambda: now)
    require(not output.exists() and not output.is_symlink(), "output must be new")
    with tempfile.TemporaryDirectory(prefix="oc-main-image-evidence-") as temporary:
        files, artifacts, producer, _ = documents(
            api, source, run_id, attempt, Path(temporary), clock, False
        )
        require(producer["event"] == event, "event authority mismatch")
        require(
            not any(a["name"] == f"trusted-main-images-{attempt}" for a in artifacts),
            "candidate artifact already exists",
        )
        output.mkdir(parents=True)
        for name in [
            *sorted(n for n in files if n != "candidate.json"),
            "candidate.json",
        ]:
            with (output / name).open("xb") as stream:
                stream.write(files[name])
    return Q.decode(files["candidate.json"])


def validate(api, source, run_id, attempt, *, now=None):
    clock = (lambda: datetime.now(timezone.utc)) if now is None else (lambda: now)
    with tempfile.TemporaryDirectory(prefix="oc-validate-main-images-") as temporary:
        work = Path(temporary)
        files, artifacts, producer, jobs = documents(
            api, source, run_id, attempt, work, clock, True
        )
        selected = [
            a for a in artifacts if a["name"] == f"trusted-main-images-{attempt}"
        ]
        require(len(selected) == 1, "missing/duplicate candidate artifact")
        artifact = selected[0]
        reference = artifact_reference(
            api,
            artifact,
            {**producer, "source": source},
            jobs[PRODUCER_JOB],
            "Retain trusted-main candidate evidence",
            clock(),
        )
        archive, directory = work / "candidate.zip", work / "candidate"
        api.download(artifact, archive)
        unpack(archive, directory, set(files), set())
        require(
            all(Q.regular(directory / name) == data for name, data in files.items()),
            "candidate/provenance does not match independent evidence",
        )
        require(
            api.json(f"{PREFIX}/actions/artifacts/{artifact['id']}") == artifact,
            "candidate artifact changed during validation",
        )
        # Recheck the current attempt after the final candidate transfer too.
        recheck_artifacts(
            api,
            [
                a
                for a in artifacts
                if a["name"] in {f"image-{role}-{attempt}" for role in Q.IMAGES}
            ],
            clock,
        )
        inspect_run(api, source, run_id, attempt, clock(), True)
        candidate = Q.decode(files["candidate.json"])
        require(
            min(
                timestamp(candidate["eligibleUntil"]), timestamp(reference["expiresAt"])
            )
            > clock(),
            "candidate/image artifact expired during validation",
        )
        images = {
            role: {
                k: image[k]
                for k in (
                    "repository",
                    "digest",
                    "platforms",
                    "buildSourceSha",
                    "qualificationArtifactId",
                    "sbomArtifactId",
                )
            }
            for role, image in candidate["images"].items()
        }
        for image in images.values():
            image["provenanceArtifactId"] = artifact["id"]
        return {
            "schemaVersion": 1,
            "buildSourceSha": source,
            "producer": producer,
            "candidateArtifact": reference,
            "imageArtifacts": {
                role: image["qualificationArtifact"]
                for role, image in candidate["images"].items()
            },
            "images": images,
            "eligibleUntil": min(
                candidate["eligibleUntil"], reference["expiresAt"], key=timestamp
            ),
            "releaseAuthority": False,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("assemble")
    build.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("validate")
    verify.add_argument("--source", required=True)
    verify.add_argument("--run-id", type=int, required=True)
    verify.add_argument("--run-attempt", type=int, required=True)
    args = parser.parse_args()
    if args.command == "assemble":
        producer_context(
            os.environ
        )  # Reject PR/fork context before even reading the token.
    api = Github(os.environ.get("GH_TOKEN", ""))
    result = (
        assemble(api, os.environ, args.output)
        if args.command == "assemble"
        else validate(api, args.source, args.run_id, args.run_attempt)
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = (
            str(error)
            if isinstance(error, ValueError)
            else "Evidence validation failed"
        )
        print(message, file=sys.stderr)
        raise SystemExit(1) from None
