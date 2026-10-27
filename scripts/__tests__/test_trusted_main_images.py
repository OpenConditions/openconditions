"""Real HTTP/filesystem fixtures; no live API, Docker, credentials or publication."""

import base64
import hashlib
import http.server
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "candidate", ROOT / "trusted-main-image-evidence.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
Q = M.Q
SHA = "a" * 40
NOW = datetime(2026, 10, 27, 12, 30, tzinfo=timezone.utc)
START = "2026-10-27T12:00:00Z"
END = "2026-10-27T12:20:00Z"
REPO = {"id": M.REPO_ID, "full_name": M.REPO, "default_branch": "main"}
ENV = {
    "GITHUB_ACTIONS": "true",
    "GITHUB_REPOSITORY": M.REPO,
    "GITHUB_REPOSITORY_ID": str(M.REPO_ID),
    "GITHUB_SHA": SHA,
    "GITHUB_RUN_ID": "123",
    "GITHUB_RUN_ATTEMPT": "2",
    "GITHUB_EVENT_NAME": "push",
    "GITHUB_REF": "refs/heads/main",
    "GITHUB_WORKFLOW_SHA": SHA,
    "GITHUB_WORKFLOW_REF": M.REPO + "/.github/workflows/ci.yml@refs/heads/main",
}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def image_bundle(root, role):
    root.mkdir()
    blobs = {}

    def blob(value):
        data = value if isinstance(value, bytes) else encoded(value)
        digest = "sha256:" + Q.sha(data)
        blobs["blobs/sha256/" + digest[7:]] = data
        return {"digest": digest, "size": len(data)}

    config = blob(
        {
            "architecture": "amd64",
            "os": "linux",
            "rootfs": {"diff_ids": ["sha256:" + Q.sha(b"layer")]},
            "config": {
                "User": "1001",
                "Labels": {
                    "org.opencontainers.image.title": "OpenConditions OpenLR resolver"
                    if role == "openlr-resolver"
                    else "OpenConditions " + role
                },
            },
        }
    )
    layer = blob(b"layer")
    manifest = blob(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": config,
            "layers": [layer],
        }
    )
    documents = {
        "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
        "index.json": encoded(
            {
                "schemaVersion": 2,
                "manifests": [
                    {
                        **manifest,
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "platform": {"os": "linux", "architecture": "amd64"},
                    }
                ],
            }
        ),
        **blobs,
    }
    with tarfile.open(root / "image.oci.tar", "w") as archive:
        for name, data in documents.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    identity = Q.inspect_archive(root / "image.oci.tar")
    checks = {
        "openlrGraphHttpNative": {
            "graphCounts": [5, 5],
            "invalidReferenceStatus": 400,
            "match": {"confidence": 0.9},
        }
    }
    if role != "openlr-resolver":
        checks = {
            "httpNativeCrypto": {
                "status": "ok",
                "service": "openconditions-federation-api"
                if role == "federation"
                else "openconditions-" + role,
            },
            "migratedTables": 58,
        }
    if role == "ingest":
        checks.update(
            osmiumVersion="osmium version 1.19.1",
            bundledFeedsMigrationsImpit=True,
            osmiumFileInfo={"data": {"count": {"nodes": 5}}},
        )
    values = {
        "identity.json": identity,
        "runtime.json": {
            "identity": identity,
            "passed": True,
            "health": "healthy",
            "physicalPostGIS": "160004|3.4.3",
            "checks": checks,
            "dockerRuntimeImageId": identity["configDigest"],
            "loadedImageCleanup": {"owned": False},
            "cleanup": [
                {"kind": k, "name": str(i), "removalExit": 0, "absent": True}
                for i, k in enumerate(["container", "container", "network"])
            ],
        },
        "scan.json": {
            "SchemaVersion": 2,
            "CreatedAt": "2026-10-27T12:08:00Z",
            "Metadata": {"ImageID": identity["configDigest"]},
            "Results": [
                {"Type": t, "Packages": [{"Name": "fixture"}]}
                for t in [
                    "alpine",
                    "python-pkg" if role == "openlr-resolver" else "node-pkg",
                ]
            ],
        },
        "sbom.cdx.json": {
            "bomFormat": "CycloneDX",
            "components": [{"name": "fixture"}],
            "metadata": {
                "tools": {"components": [{"name": "trivy", "version": "0.76.1"}]},
                "component": {
                    "properties": [
                        {
                            "name": "aquasecurity:trivy:ImageID",
                            "value": identity["configDigest"],
                        }
                    ]
                },
            },
        },
        "scanner-db.json": {
            "Version": 2,
            "UpdatedAt": START,
            "NextUpdate": "2026-10-28T00:00:00Z",
        },
        "build-metadata.json": {
            "containerimage.config.digest": identity["configDigest"],
            "containerimage.digest": identity["platformManifestDigest"],
            "buildx.build.ref": "fixture/build/ref",
        },
    }
    for name, value in values.items():
        (root / name).write_bytes(encoded(value))
    (root / "build.log").write_text("actual build log fixture\n")
    result = Q.verify_reports(
        root, role, SHA, {"kind": "github", "runId": 123, "attempt": 2}
    )
    (root / "qualified.json").write_bytes(encoded(result))


def packed(root, extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.iterdir()):
            archive.write(path, path.name)
        if extra:
            for name, value in extra.items():
                archive.writestr(name, value)
    return stream.getvalue()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="oc-candidate-test-")
        self.root = Path(self.temporary.name)
        self.run = {
            "id": 123,
            "run_attempt": 2,
            "workflow_id": M.WORKFLOW_ID,
            "path": M.WORKFLOW,
            "event": "push",
            "head_sha": SHA,
            "head_branch": "main",
            "repository": REPO,
            "head_repository": REPO,
            "status": "in_progress",
            "conclusion": None,
            "created_at": START,
            "run_started_at": START,
        }
        self.jobs = []
        for i, name in enumerate(M.GATES):
            steps = []
            if name.startswith("image ("):
                steps = [
                    {
                        "name": "Build, smoke, scan and bind image evidence",
                        "status": "completed",
                        "conclusion": "success",
                    },
                    {
                        "name": "Retain qualification or failure evidence",
                        "status": "completed",
                        "conclusion": "success",
                        "started_at": "2026-10-27T12:09:00Z",
                        "completed_at": "2026-10-27T12:12:00Z",
                    },
                ]
            self.jobs.append(
                {
                    "id": i + 1000,
                    "name": name,
                    "run_id": 123,
                    "head_sha": SHA,
                    "status": "completed",
                    "conclusion": "success",
                    "started_at": START,
                    "completed_at": END,
                    "steps": steps,
                }
            )
        self.jobs.append(
            {
                "id": 9999,
                "name": M.PRODUCER_JOB,
                "run_id": 123,
                "head_sha": SHA,
                "status": "in_progress",
                "conclusion": None,
                "started_at": "2026-10-27T12:21:00Z",
                "completed_at": None,
                "steps": [],
            }
        )
        self.artifacts, self.zips = [], {}
        for i, role in enumerate(Q.IMAGES):
            directory = self.root / role
            image_bundle(directory, role)
            self.add_artifact(200 + i, f"image-{role}-2", packed(directory))
        self.calls = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.calls.append((self.path, self.headers.get("Authorization")))
                status, headers, body = owner.response(self.path)
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        opener = urllib.request.build_opener(NoRedirect())

        def request(url, headers, timeout):
            parsed = urllib.parse.urlsplit(url)
            route = parsed.path + ("?" + parsed.query if parsed.query else "")
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.server.server_port}" + route, headers=headers
            )
            try:
                return opener.open(req, timeout=timeout)
            except urllib.error.HTTPError as error:
                return error

        self.api = M.Github("fixture-token", request=request)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def add_artifact(self, identity, name, data):
        self.zips[identity] = data
        self.artifacts.append(
            {
                "id": identity,
                "name": name,
                "size_in_bytes": len(data),
                "digest": "sha256:" + Q.sha(data),
                "expired": False,
                "created_at": "2026-10-27T12:10:00Z",
                "expires_at": "2026-10-30T12:10:00Z",
                "workflow_run": {
                    "id": 123,
                    "repository_id": M.REPO_ID,
                    "head_repository_id": M.REPO_ID,
                    "head_branch": "main",
                    "head_sha": SHA,
                },
            }
        )

    def response(self, route):
        prefix = "/repos/" + M.REPO
        value = None
        if route == prefix:
            value = REPO
        elif route == prefix + "/actions/workflows/ci.yml":
            value = {"id": M.WORKFLOW_ID, "path": M.WORKFLOW, "state": "active"}
        elif route in [
            prefix + "/actions/runs/123",
            prefix + "/actions/runs/123/attempts/2",
        ]:
            value = self.run
        elif route == prefix + "/actions/runs/123/attempts/2/jobs?per_page=100&page=1":
            value = {"total_count": len(self.jobs), "jobs": self.jobs}
        elif route == prefix + "/actions/runs/123/artifacts?per_page=100&page=1":
            value = {"total_count": len(self.artifacts), "artifacts": self.artifacts}
        elif route == prefix + "/contents/.github/workflows/ci.yml?ref=" + SHA:
            content = b"name: CI\n# fixture toolchain pins\n"
            oid = hashlib.sha1(
                b"blob " + str(len(content)).encode() + b"\0" + content
            ).hexdigest()
            value = {
                "type": "file",
                "path": M.WORKFLOW,
                "sha": oid,
                "encoding": "base64",
                "content": base64.b64encode(content).decode(),
            }
        elif route.startswith(prefix + "/actions/artifacts/"):
            part = route[len(prefix + "/actions/artifacts/") :].split("/")
            artifact = next(
                (a for a in self.artifacts if str(a["id"]) == part[0]), None
            )
            if artifact and len(part) == 1:
                value = artifact
            elif artifact and part[1:] == ["zip"]:
                return (
                    302,
                    {
                        "Location": "https://fixture.blob.core.windows.net/blob/"
                        + part[0]
                    },
                    b"",
                )
        elif route.startswith("/blob/"):
            return 200, {}, self.zips[int(route.split("/")[-1])]
        return (
            (200, {}, encoded(value)) if value is not None else (404, {}, b"not found")
        )

    def assemble(self):
        return M.assemble(self.api, ENV, self.root / "candidate", now=NOW)

    def complete(self):
        self.assemble()
        self.add_artifact(300, "trusted-main-images-2", packed(self.root / "candidate"))
        self.artifacts[-1].update(
            created_at="2026-10-27T12:25:00Z", expires_at="2026-10-30T12:25:00Z"
        )
        self.run.update(status="completed", conclusion="success")
        self.jobs[-1].update(
            status="completed",
            conclusion="success",
            completed_at=END.replace("12:20", "12:26"),
            steps=[
                {
                    "name": "Retain trusted-main candidate evidence",
                    "status": "completed",
                    "conclusion": "success",
                    "started_at": "2026-10-27T12:24:00Z",
                    "completed_at": "2026-10-27T12:26:00Z",
                }
            ],
        )

    def test_assemble_and_independent_api_validation(self):
        self.complete()
        result = M.validate(self.api, SHA, 123, 2, now=NOW)
        self.assertFalse(result["releaseAuthority"])
        self.assertEqual(set(result["images"]), set(Q.IMAGES))
        for image in result["images"].values():
            self.assertEqual(image["buildSourceSha"], SHA)
            self.assertEqual(image["provenanceArtifactId"], 300)
            self.assertEqual(image["sbomArtifactId"], image["qualificationArtifactId"])
        self.assertEqual(result["eligibleUntil"], "2026-10-30T12:10:00Z")
        self.assertTrue(any(path.startswith("/blob/") for path, _ in self.calls))
        self.assertTrue(
            all(auth is None for path, auth in self.calls if path.startswith("/blob/"))
        )

    def test_wrong_authority(self):
        for key, value in [
            ("event", "pull_request"),
            ("event", "schedule"),
            ("head_branch", "feature"),
            ("head_sha", "b" * 40),
            ("workflow_id", 999),
            ("run_attempt", 1),
            ("id", 999),
            ("path", ".github/workflows/release.yml"),
            ("head_repository", {**REPO, "id": 999}),
            ("repository", {**REPO, "full_name": "fork/openconditions"}),
        ]:
            with self.subTest(key=key, value=value):
                original = self.run[key]
                self.run[key] = value
                with self.assertRaisesRegex(ValueError, "authority"):
                    self.assemble()
                self.run[key] = original
                self.assertFalse((self.root / "candidate/candidate.json").exists())

    def test_forged_environment_rejected_before_api(self):
        for key, value in [
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_REF", "refs/pull/1/merge"),
            ("GITHUB_REPOSITORY", "fork/openconditions"),
            ("GITHUB_REPOSITORY_ID", "999"),
            ("GITHUB_ACTIONS", "false"),
            ("GITHUB_WORKFLOW_SHA", "b" * 40),
            ("GITHUB_WORKFLOW_REF", M.REPO + "/.github/workflows/ci.yml@feature"),
        ]:
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError, "context"):
                    M.assemble(
                        self.api, {**ENV, key: value}, self.root / "candidate", now=NOW
                    )
        self.assertEqual(self.calls, [])

    def test_missing_failed_cancelled_skipped_and_unknown_job(self):
        for bad in ["failure", "cancelled", "skipped", None]:
            for job in self.jobs[:-1]:
                original = job["conclusion"]
                job["conclusion"] = bad
                with self.assertRaisesRegex(ValueError, "coverage"):
                    self.assemble()
                job["conclusion"] = original
        missing = self.jobs.pop(0)
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.assemble()
        self.jobs.append(missing)
        self.jobs.append({**missing, "name": "unknown source gate"})
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.assemble()

    def test_partial_expired_wrong_artifact_and_hash_drift(self):
        artifact = self.artifacts[0]
        for key, value in [
            ("expired", True),
            ("expires_at", "2026-10-27T12:11:00Z"),
            ("expires_at", "2026-11-27T12:10:00Z"),
            ("digest", "sha256:" + "0" * 64),
            ("created_at", "2026-10-27T11:00:00Z"),
            ("workflow_run", {**artifact["workflow_run"], "head_sha": "b" * 40}),
        ]:
            with self.subTest(key=key):
                original = artifact[key]
                artifact[key] = value
                with self.assertRaisesRegex(ValueError, "artifact"):
                    self.assemble()
                artifact[key] = original
        self.artifacts.pop()
        with self.assertRaisesRegex(ValueError, "artifact"):
            self.assemble()

    def test_unsafe_archive_and_forged_receipt(self):
        artifact = self.artifacts[0]
        role = next(iter(Q.IMAGES))
        original = self.zips[artifact["id"]]
        for extra in [
            {"../escape": b"bad"},
            {"untrusted-script.py": b"bad"},
            {"qualified.json": b"{}"},
        ]:
            value = packed(self.root / role, extra)
            self.zips[artifact["id"]] = value
            artifact.update(digest="sha256:" + Q.sha(value), size_in_bytes=len(value))
            with self.assertRaisesRegex(ValueError, "artifact|receipt"):
                self.assemble()
        self.assertFalse((self.root / "escape").exists())
        self.zips[artifact["id"]] = original

    def test_expiry_during_download_cannot_renew_authority(self):
        moment = [NOW]
        original = self.api.download

        def download(artifact, path):
            original(artifact, path)
            moment[0] = datetime(2026, 10, 30, 12, 11, tzinfo=timezone.utc)

        self.api.download = download
        original_datetime = M.datetime

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return moment[0]

        M.datetime = Clock
        try:
            with self.assertRaisesRegex(ValueError, "expired|retention"):
                M.assemble(self.api, ENV, self.root / "candidate")
        finally:
            M.datetime = original_datetime
        self.assertFalse((self.root / "candidate/candidate.json").exists())

    def test_earlier_artifact_deleted_during_later_image_transfer(self):
        original = self.api.download

        def download(artifact, path):
            original(artifact, path)
            if artifact["id"] == 201:
                self.artifacts = [a for a in self.artifacts if a["id"] != 200]

        self.api.download = download
        with self.assertRaisesRegex(ValueError, "API|artifact"):
            self.assemble()
        self.assertFalse((self.root / "candidate/candidate.json").exists())

    def test_source_artifact_deleted_during_final_candidate_transfer(self):
        self.complete()
        original = self.api.download

        def download(artifact, path):
            original(artifact, path)
            if artifact["id"] == 300:
                self.artifacts = [a for a in self.artifacts if a["id"] != 200]

        self.api.download = download
        with self.assertRaisesRegex(ValueError, "API|artifact"):
            M.validate(self.api, SHA, 123, 2, now=NOW)

    def test_run_attempt_advances_during_transfer(self):
        original = self.api.download

        def download(artifact, path):
            original(artifact, path)
            self.run["run_attempt"] = 3

        self.api.download = download
        with self.assertRaisesRegex(ValueError, "authority"):
            self.assemble()
        self.assertFalse((self.root / "candidate/candidate.json").exists())

    def test_missing_or_substituted_candidate_artifact(self):
        self.complete()
        artifact = self.artifacts.pop()
        with self.assertRaisesRegex(ValueError, "candidate"):
            M.validate(self.api, SHA, 123, 2, now=NOW)
        self.artifacts.append(artifact)
        provenance = self.root / "candidate/ingest.provenance.json"
        data = json.loads(provenance.read_text())
        data["buildSourceSha"] = "b" * 40
        provenance.write_bytes(encoded(data))
        value = packed(provenance.parent)
        self.zips[300] = value
        artifact.update(digest="sha256:" + Q.sha(value), size_in_bytes=len(value))
        with self.assertRaisesRegex(ValueError, "candidate"):
            M.validate(self.api, SHA, 123, 2, now=NOW)

    def test_redirect_cannot_exfiltrate_token_and_api_errors_fail(self):
        original = self.response

        def response(route):
            if route.endswith("/zip"):
                return 302, {"Location": "https://attacker.invalid/artifact"}, b""
            return original(route)

        self.response = response
        with self.assertRaisesRegex(ValueError, "origin"):
            self.assemble()
        self.assertFalse(any(p.startswith("/artifact") for p, _ in self.calls))
        self.response = lambda route: (403, {}, b"denied")
        with self.assertRaisesRegex(ValueError, "API"):
            self.assemble()

    def test_cli_context_guard_and_bounded_api_failures(self):
        process = subprocess.run(
            [
                sys.executable,
                str(ROOT / "trusted-main-image-evidence.py"),
                "assemble",
                "--output",
                str(self.root / "candidate"),
            ],
            env={
                **os.environ,
                **ENV,
                "GITHUB_EVENT_NAME": "pull_request",
                "GH_TOKEN": "",
            },
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(process.returncode, 1)
        self.assertIn("context", process.stderr)
        self.assertNotIn("token", process.stderr)
        original = self.response
        requests, delays = [], []

        def response(route):
            if route == M.PREFIX and len(requests) < 4:
                requests.append(route)
                return 503, {}, b"unavailable"
            return original(route)

        self.response = response
        self.api.sleep = delays.append
        with self.assertRaisesRegex(ValueError, "bounded retries"):
            self.assemble()
        self.assertEqual(len(requests), 4)
        self.assertEqual(delays, [1, 2, 4])

    def test_incomplete_pagination_and_workflow_blob_hash(self):
        original = self.response

        def response(route):
            status, headers, body = original(route)
            if "/jobs?" in route:
                value = json.loads(body)
                value["total_count"] += 1
                body = encoded(value)
            return status, headers, body

        self.response = response
        with self.assertRaisesRegex(ValueError, "pagination"):
            self.assemble()

        def response(route):
            status, headers, body = original(route)
            if "/contents/" in route:
                value = json.loads(body)
                value["sha"] = "b" * 40
                body = encoded(value)
            return status, headers, body

        self.response = response
        with self.assertRaisesRegex(ValueError, "authority hash"):
            self.assemble()

    def test_symlink_and_report_substitution_with_valid_zip_hash(self):
        artifact = self.artifacts[0]
        root = self.root / next(iter(Q.IMAGES))
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for path in root.iterdir():
                if path.name != "build.log":
                    archive.write(path, path.name)
            link = zipfile.ZipInfo("build.log")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "../../outside")
        value = stream.getvalue()
        self.zips[artifact["id"]] = value
        artifact.update(digest="sha256:" + Q.sha(value), size_in_bytes=len(value))
        with self.assertRaisesRegex(ValueError, "nonregular"):
            self.assemble()
        scan = root / "scan.json"
        doc = json.loads(scan.read_text())
        doc["Metadata"]["ImageID"] = "sha256:" + "0" * 64
        scan.write_bytes(encoded(doc))
        value = packed(root)
        self.zips[artifact["id"]] = value
        artifact.update(digest="sha256:" + Q.sha(value), size_in_bytes=len(value))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.assemble()

    def test_candidate_is_not_authority_and_completed_attempt_required(self):
        self.complete()
        for key, value in [
            ("status", "in_progress"),
            ("conclusion", "failure"),
            ("run_attempt", 3),
            ("event", "pull_request"),
        ]:
            with self.subTest(key=key):
                original = self.run[key]
                self.run[key] = value
                with self.assertRaisesRegex(ValueError, "authority"):
                    M.validate(self.api, SHA, 123, 2, now=NOW)
                self.run[key] = original
        artifact = self.artifacts[-1]
        candidate = self.root / "candidate/candidate.json"
        data = json.loads(candidate.read_text())
        data["buildSourceSha"] = "b" * 40
        candidate.write_bytes(encoded(data))
        value = packed(candidate.parent)
        self.zips[300] = value
        artifact.update(digest="sha256:" + Q.sha(value), size_in_bytes=len(value))
        with self.assertRaisesRegex(ValueError, "candidate"):
            M.validate(self.api, SHA, 123, 2, now=NOW)


if __name__ == "__main__":
    unittest.main()
