"""Owned Git, actual loopback API/artifacts, Node CLI and BuildKit; no live operations."""

import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from datetime import timedelta
import test_trusted_main_images as F

SPEC = importlib.util.spec_from_file_location(
    "product", F.ROOT / "qualify-product-release.py"
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


class ProductTests(F.CandidateTests):
    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def put(self, path, data):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data if isinstance(data, bytes) else json.dumps(data).encode())

    def commit(self):
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Owned",
            "-c",
            "user.email=owned@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-qm",
            "owned fixture",
        )
        return self.git("rev-parse", "HEAD")

    def setUp(self):
        self.git_temp = tempfile.TemporaryDirectory(prefix="oc-product-git-")
        self.repo = Path(self.git_temp.name)
        self.git("init", "-q")
        self.git(
            "remote",
            "add",
            "origin",
            "https://github.com/OpenConditions/openconditions.git",
        )
        paths = [
            *P.POLICY,
            ".dockerignore",
            "extension.json",
            "services/openlr-resolver/.dockerignore",
            "services/ingest/.dockerignore",
            "services/openlr-resolver/requirements.txt",
            "services/openlr-resolver/app/__main__.py",
            *[f"services/{role}/Dockerfile" for role in P.N.Q.IMAGES],
            *[
                f"services/{role}/service.json"
                for role in [
                    "ingest",
                    "ingest-heavy",
                    "contributions-api",
                    "federation",
                ]
            ],
        ]
        for path in paths:
            self.put(path, (P.TOOLS / path).read_bytes())
        self.a = self.commit()
        F.SHA = self.a
        F.ENV["GITHUB_SHA"] = self.a
        F.ENV["GITHUB_WORKFLOW_SHA"] = self.a
        super().setUp()
        self.original_response = self.response
        self.response = self.product_response
        self.complete()
        # Independent real HTTP/ZIP/report/OCI validation supplies fixture B, not B itself.
        self.native = P.N.validate(self.api, self.a, 123, 2, now=F.NOW)
        self.version = "0.8.0-alpha.1"
        self.candidate = {
            "schemaVersion": 1,
            "version": self.version,
            "imageSourceSha": self.a,
            "producer": {"workflowFile": P.N.WORKFLOW, "runId": 123, "runAttempt": 2},
            "images": self.native["images"],
        }
        self.put(f"docs/release-notes/{self.version}.json", self.candidate)
        self.put(
            f"docs/release-notes/{self.version}.md",
            b"Owned synthetic qualification notes.\n",
        )
        d = json.loads((self.repo / "extension.json").read_bytes())
        d["version"] = self.version
        for s in d["services"]:
            s["ref"] = "v" + self.version
        self.put("extension.json", d)
        for role in ["ingest", "ingest-heavy", "contributions-api", "federation"]:
            path = f"services/{role}/service.json"
            d = json.loads((self.repo / path).read_bytes())
            d["version"] = d["container"]["tag"] = self.version
            d["container"]["digest"] = self.candidate["images"][
                "ingest" if role == "ingest-heavy" else role
            ]["digest"]
            self.put(path, d)
        self.b = self.commit()
        self.brun = copy.deepcopy(self.run)
        self.brun.update(id=456, head_sha=self.b, run_attempt=1)
        self.bjobs = copy.deepcopy(self.jobs)
        for job in self.bjobs:
            job.update(run_id=456, head_sha=self.b, id=job["id"] + 20000)
        self.history_drift = False
        self.final_artifact_drift = False
        self.breads = 0

    def product_response(self, route):
        prefix = P.N.PREFIX
        if route.startswith(prefix + "/contents/" + P.N.WORKFLOW):
            raw = (P.TOOLS / P.N.WORKFLOW).read_bytes()
            if (
                getattr(self, "a_workflow_drift", False)
                and self.breads > 1
                and route.endswith("=" + self.a)
            ):
                raw += b"# changed native source response\n"
            return (
                200,
                {},
                F.encoded(
                    {
                        "type": "file",
                        "path": P.N.WORKFLOW,
                        "encoding": "base64",
                        "sha": hashlib.sha1(
                            b"blob " + str(len(raw)).encode() + b"\0" + raw
                        ).hexdigest(),
                        "content": base64.b64encode(raw).decode(),
                    }
                ),
            )
        if route == prefix + "/git/ref/heads/main":
            return (
                200,
                {},
                F.encoded(
                    {
                        "ref": "refs/heads/main",
                        "object": {"sha": getattr(self, "b", self.a)},
                    }
                ),
            )
        if route in [
            prefix + "/releases?per_page=100&page=1",
            prefix + "/tags?per_page=100&page=1",
        ]:
            version = (
                "v0.9.0"
                if getattr(self, "history_drift", False) and self.breads > 1
                else "v0.7.0"
            )
            return (
                200,
                {},
                F.encoded(
                    [{"tag_name": version}]
                    if "/releases?" in route
                    else [{"name": version}]
                ),
            )
        if "/actions/workflows/ci.yml/runs?" in route:
            return 200, {}, F.encoded({"total_count": 1, "workflow_runs": [self.brun]})
        if route in [
            prefix + "/actions/runs/456",
            prefix + "/actions/runs/456/attempts/1",
        ]:
            if route.endswith("/456"):
                self.breads += 1
            return 200, {}, F.encoded(self.brun)
        if route == prefix + "/actions/runs/456/attempts/1/jobs?per_page=100&page=1":
            return (
                200,
                {},
                F.encoded({"total_count": len(self.bjobs), "jobs": self.bjobs}),
            )
        if (
            getattr(self, "final_artifact_drift", False)
            and self.breads > 1
            and route == prefix + "/actions/artifacts/200"
        ):
            data = copy.deepcopy(self.artifacts[0])
            data["workflow_run"]["head_branch"] = "other"
            return 200, {}, F.encoded(data)
        return self.original_response(route)

    def tearDown(self):
        super().tearDown()
        self.git_temp.cleanup()

    def qualify(self):
        return P.qualify(
            self.api,
            self.repo,
            self.b,
            self.a,
            self.b,
            123,
            2,
            456,
            1,
            self.version,
            clock=lambda: F.NOW,
        )

    def test_product_positive(self):
        self.git(
            "remote",
            "set-url",
            "origin",
            "https://github.com/OpenConditions/openconditions",
        )
        before = (self.repo / ".git/index").read_bytes()
        receipt = self.qualify()
        self.assertFalse(receipt["releaseAuthority"])
        self.assertEqual(receipt["tagTargetSha"], self.b)
        self.assertEqual(len(receipt["imageEvidence"]["imageArtifacts"]), 4)
        self.assertEqual(before, (self.repo / ".git/index").read_bytes())
        self.assertEqual(self.git("status", "--porcelain"), "")
        with self.assertRaisesRegex(ValueError, "unknown/missing receipt fields"):
            P.validate_receipt({**receipt, "publish": True})

    def test_product_main_and_run_readback(self):
        # Advance the latest B attempt only at the completion readback.
        original = self.product_response

        def response(route):
            if route == P.N.PREFIX + "/actions/runs/456" and self.breads >= 1:
                self.brun["run_attempt"] = 2
            return original(route)

        self.response = response
        with self.assertRaisesRegex(ValueError, "run authority mismatch"):
            self.qualify()

    def test_product_unused_version(self):
        self.version = "0.7.0"
        with self.assertRaisesRegex(ValueError, "later than native history"):
            self.qualify()

    def test_product_b_bad(self):
        for change in [
            {"event": "pull_request"},
            {"run_attempt": 2},
            {"status": "in_progress"},
            {"conclusion": "failure"},
        ]:
            with self.subTest(change=change):
                old = copy.deepcopy(self.brun)
                self.brun.update(change)
                with self.assertRaises(ValueError):
                    self.qualify()
                self.brun = old
        self.bjobs[0]["conclusion"] = "skipped"
        with self.assertRaisesRegex(ValueError, "coverage did not complete"):
            self.qualify()

    def test_product_history_drift(self):
        self.history_drift = True
        with self.assertRaisesRegex(ValueError, "main/history changed"):
            self.qualify()

    def test_product_artifact_final_drift(self):
        self.final_artifact_drift = True
        with self.assertRaisesRegex(ValueError, "artifact changed/expired"):
            self.qualify()

    def test_product_a_source_readback(self):
        self.a_workflow_drift = True
        with self.assertRaisesRegex(ValueError, "A authority changed"):
            self.qualify()

    def test_product_live_clock(self):
        owner = self
        owner.transfer_done = False
        original = self.api.download

        def download(*args):
            original(*args)
            owner.transfer_done = True

        self.api.download = download

        class Clock(P.datetime):
            @classmethod
            def now(cls, tz=None):
                return F.NOW + (
                    timedelta(days=4) if owner.transfer_done else timedelta()
                )

        with patch.object(P, "datetime", Clock), patch.object(P.N, "datetime", Clock):
            with self.assertRaisesRegex(ValueError, "artifact expired during transfer"):
                P.qualify(
                    self.api,
                    self.repo,
                    self.b,
                    self.a,
                    self.b,
                    123,
                    2,
                    456,
                    1,
                    self.version,
                )

    def test_product_policy_drift(self):
        self.put(".nvmrc", b"99.0.0\n")
        changed = self.commit()
        with self.assertRaisesRegex(ValueError, "trusted tool bytes differ"):
            P.qualify(
                self.api,
                self.repo,
                changed,
                self.a,
                self.b,
                123,
                2,
                456,
                1,
                self.version,
                clock=lambda: F.NOW,
            )

    def test_product_expired(self):
        self.artifacts[0]["expired"] = True
        with self.assertRaisesRegex(ValueError, "artifact authority"):
            self.qualify()

    def test_product_substituted(self):
        self.zips[200] = b"substituted"
        with self.assertRaises(ValueError):
            self.qualify()

    def test_product_cli_context(self):
        r = subprocess.run(
            ["python3", str(P.TOOLS / "scripts/qualify-product-release.py")],
            env={"PATH": __import__("os").environ["PATH"]},
            capture_output=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"untrusted qualification context", r.stderr)


if __name__ == "__main__":
    suite = unittest.TestSuite(
        ProductTests(name)
        for name in unittest.defaultTestLoader.getTestCaseNames(ProductTests)
        if name.startswith("test_product_")
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
