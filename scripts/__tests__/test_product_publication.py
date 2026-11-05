"""Owned Git/HTTP/OCI effects only, never live publication authority."""

import copy
import os
import tempfile
from datetime import timedelta
import http.server
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
import urllib.parse
import test_product_qualification as T

SPEC = importlib.util.spec_from_file_location(
    "publication", Path(__file__).resolve().parents[1] / "publish-product-release.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class Guards(unittest.TestCase):
    def test_missing_readiness_never_authorizes(self):
        for value in [None, {}, {"outcome": "passed"}, {"approved": True}]:
            with self.assertRaisesRegex(ValueError, "trusted full-readiness"):
                M.require_execution_authority(value)

    def test_actual_assessment_process(self):
        with tempfile.TemporaryDirectory(prefix="oc-publication-assessment-") as root:
            output = Path(root) / "output"
            summary = Path(root) / "summary"
            env = {
                k: v
                for k, v in os.environ.items()
                if k not in ["GH_TOKEN", "GITHUB_TOKEN"]
            }
            env.update(
                {
                    "GITHUB_ACTIONS": "true",
                    "GITHUB_REPOSITORY": M.N.REPO,
                    "GITHUB_REPOSITORY_ID": str(M.N.REPO_ID),
                    "GITHUB_SHA": "a" * 40,
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_WORKFLOW_REF": M.N.REPO
                    + "/.github/workflows/product-release.yml@refs/heads/main",
                    "GITHUB_WORKFLOW_SHA": "a" * 40,
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_OUTPUT": str(output),
                    "GITHUB_STEP_SUMMARY": str(summary),
                }
            )
            result = subprocess.run(
                ["python3", "-B", str(Path(M.__file__)), "--assess"],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(output.read_text(), "ready=false\n")
            self.assertIn("Publication remains blocked", summary.read_text())
            output.unlink()
            env["GITHUB_REPOSITORY"] = "owned/fork"
            result = subprocess.run(
                ["python3", "-B", str(Path(M.__file__)), "--assess"],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_protections(self):
        policy = {"name": "owned", "rules": []}
        env = {
            "id": 1,
            "name": M.ENVIRONMENT,
            "can_admins_bypass": False,
            "protection_rules": [
                {
                    "type": "required_reviewers",
                    "prevent_self_review": False,
                    "reviewers": [{"type": "User", "reviewer": M.OWNER}],
                }
            ],
            "deployment_branch_policy": {
                "protected_branches": False,
                "custom_branch_policies": True,
            },
        }
        values = {
            M.N.PREFIX: {
                "id": M.N.REPO_ID,
                "full_name": M.N.REPO,
                "default_branch": "main",
            },
            M.N.PREFIX + "/git/ref/heads/main": {"object": {"sha": "a" * 40}},
            M.N.PREFIX + "/rulesets/18081110": policy,
            M.N.PREFIX + "/environments/" + M.ENVIRONMENT: env,
            M.N.PREFIX
            + "/environments/"
            + M.ENVIRONMENT
            + "/deployment-branch-policies?per_page=100": {
                "total_count": 1,
                "branch_policies": [{"name": "main", "type": "branch"}],
            },
            M.N.PREFIX + "/immutable-releases": {"enabled": True},
            M.N.PREFIX + "/actions/runs/123/approvals": [
                {
                    "state": "approved",
                    "user": M.OWNER,
                    "environments": [{"id": 1, "name": M.ENVIRONMENT}],
                }
            ],
        }

        class API:
            def json(self, route):
                return values[route]

        expected = M.Q.sha(
            M.N.canonical(
                {
                    k: policy.get(k)
                    for k in [
                        "name",
                        "target",
                        "enforcement",
                        "bypass_actors",
                        "conditions",
                        "rules",
                    ]
                }
            )
        )
        with patch.object(M, "MAIN_POLICY_SHA256", expected):
            M.protections(API(), "a" * 40, 123, True)
            for change in [
                lambda: env.update(can_admins_bypass=True),
                lambda: env["protection_rules"].clear(),
                lambda: values[M.N.PREFIX + "/immutable-releases"].update(
                    enabled=False
                ),
                lambda: values[M.N.PREFIX + "/actions/runs/123/approvals"].clear(),
                lambda: policy.update(name="drift"),
                lambda: env["deployment_branch_policy"].update(protected_branches=True),
            ]:
                saved = copy.deepcopy(values)
                change()
                with self.assertRaises(ValueError):
                    M.protections(API(), "a" * 40, 123, True)
                values.clear()
                values.update(saved)
                env = values[M.N.PREFIX + "/environments/" + M.ENVIRONMENT]
                policy = values[M.N.PREFIX + "/rulesets/18081110"]


class Publication(T.ProductTests):
    def test_publication_http_git_registry(self):
        q = self.qualify()
        bundle = M.B.bundle_files(self.repo, q, None, T.F.NOW)
        bundle["portable.json"] = M.N.canonical({"kind": "owned portable fixture only"})
        manifest = M.Q.decode(bundle["bundle.json"])
        manifest["inventory"]["portable.json"] = {
            "sha256": M.Q.sha(bundle["portable.json"]),
            "mode": 0o644,
        }
        bundle["bundle.json"] = M.N.canonical(manifest)
        directories = {r: self.root / r for r in M.Q.IMAGES}
        provenance = {
            r: (self.root / "candidate" / f"{r}.provenance.json").read_bytes()
            for r in M.Q.IMAGES
        }
        execution = {
            "readiness.json": M.N.canonical(
                {
                    "schemaVersion": 1,
                    "imageSourceSha": self.a,
                    "manifestSourceSha": self.b,
                    "images": {
                        k: v["digest"] for k, v in q["imageEvidence"]["images"].items()
                    },
                    "platform": "linux/amd64",
                    "postgresMajor": 16,
                    "priorDeployment": {
                        "identity": "owned fixture, not a real deployment",
                        "sourceSha": "1" * 40,
                        "imageDigest": "sha256:" + "2" * 64,
                        "schemaSha256": "3" * 64,
                    },
                    "steps": {
                        k: {
                            "outcome": "passed",
                            "startedAt": "2026-10-26T00:00:00Z",
                            "completedAt": "2026-10-26T00:01:00Z",
                            "tool": {
                                "name": "owned fixture",
                                "version": "1",
                                "sha256": "4" * 64,
                            },
                            "evidenceSha256": "5" * 64,
                        }
                        for k in M.B.STEPS
                    },
                }
            ),
            "rehearsal.json": M.N.canonical(
                {
                    "imageSourceSha": self.a,
                    "manifestSourceSha": self.b,
                    "images": q["imageEvidence"]["images"],
                    "services": {
                        k: {"outcome": "passed"}
                        for k in ["ingest", "contributions-api"]
                    },
                }
            ),
            "rights-privacy.json": M.N.canonical(
                {"success": True, "numFailedTests": 0, "numPassedTests": 1}
            ),
        }
        files = M.assets(bundle, directories, provenance, execution, T.F.NOW)
        images = {r: p / "image.oci.tar" for r, p in directories.items()}
        with self.assertRaises(ValueError):
            M.assets(
                bundle,
                {**directories, "unknown": self.root},
                provenance,
                execution,
                T.F.NOW,
            )
        for changed in [
            {},
            {**execution, "rights-privacy.json": M.N.canonical({"success": False})},
            {**execution, "readiness.json": b"null"},
        ]:
            with self.assertRaises(ValueError):
                M.assets(bundle, directories, provenance, changed, T.F.NOW)
        altered_provenance = dict(provenance)
        doc = M.Q.decode(altered_provenance["ingest"])
        doc["buildSourceSha"] = self.b
        altered_provenance["ingest"] = M.N.canonical(doc)
        with self.assertRaises(ValueError):
            M.assets(bundle, directories, altered_provenance, execution, T.F.NOW)
        sbom = directories["ingest"] / "sbom.cdx.json"
        original = sbom.read_bytes()
        sbom.write_bytes(b"{}")
        try:
            with self.assertRaises(ValueError):
                M.assets(bundle, directories, provenance, execution, T.F.NOW)
        finally:
            sbom.write_bytes(original)
        # Actual owned file replacement after verified reads must not become a
        # new publication inventory describing different bytes than provenance.
        for name in ["scan.json", "sbom.cdx.json", "qualified.json"]:
            path = directories["ingest"] / name
            original = path.read_bytes()
            reads = []
            regular = M.Q.regular

            def replace_after_verify(target):
                if target == path:
                    reads.append(1)
                    if len(reads) == 2:
                        path.write_bytes(b"{}")
                return regular(target)

            try:
                with (
                    patch.object(M.Q, "regular", replace_after_verify),
                    self.assertRaisesRegex(ValueError, "report bytes changed"),
                ):
                    M.assets(bundle, directories, provenance, execution, T.F.NOW)
            finally:
                path.write_bytes(original)
        state = {
            "release": None,
            "assets": {},
            "manifests": {},
            "blobs": {},
            "writes": [],
            "fail": None,
        }
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def request(self):
                path = urllib.parse.urlsplit(self.path).path
                params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                method = self.command
                headers = {}
                status = 200
                value = None
                raw = None
                if method not in ["GET", "HEAD"]:
                    state["writes"].append([method, path])
                    if state["fail"] and state["fail"] in path:
                        self.send_response(500)
                        self.end_headers()
                        return
                if path.startswith("/v2/"):
                    if "/manifests/" in path:
                        if method == "PUT":
                            state["manifests"][path] = body
                            status = 201
                        raw = state["manifests"].get(path)
                        status = status if raw is not None else 404
                        if raw is not None:
                            headers["Docker-Content-Digest"] = "sha256:" + M.Q.sha(raw)
                    elif path.endswith("/uploads/"):
                        status = 202
                        headers["Location"] = path + "owned"
                    elif "/uploads/" in path and method == "PUT":
                        digest = params["digest"][0]
                        owner.assertEqual("sha256:" + M.Q.sha(body), digest)
                        state["blobs"][digest] = body
                        status = 201
                    elif "/blobs/" in path:
                        digest = path.split("/blobs/")[1]
                        status = 200 if digest in state["blobs"] else 404
                elif "/git/ref/tags/" in path:
                    try:
                        sha = subprocess.check_output(
                            [
                                "git",
                                "rev-parse",
                                "--verify",
                                "refs/tags/v" + owner.version,
                            ],
                            cwd=owner.repo,
                            text=True,
                            stderr=subprocess.DEVNULL,
                        ).strip()
                        value = {"object": {"type": "commit", "sha": sha}}
                    except subprocess.CalledProcessError:
                        status = 404
                elif path.endswith("/git/refs"):
                    data = json.loads(body)
                    owner.git("update-ref", data["ref"], data["sha"])
                    value = {"ref": data["ref"]}
                    status = 201
                elif "/releases/tags/" in path:
                    value = state["release"]
                    status = 200 if value else 404
                elif path.endswith("/releases"):
                    state["release"] = {**json.loads(body), "id": 7, "immutable": False}
                    value = state["release"]
                    status = 201
                elif path.endswith("/assets"):
                    if method == "POST":
                        name = params["name"][0]
                        state["assets"][name] = body
                        status = 201
                        value = {"name": name}
                    else:
                        value = [
                            {
                                "name": k,
                                "state": "uploaded",
                                "size": len(v),
                                "digest": "sha256:" + M.Q.sha(v),
                            }
                            for k, v in state["assets"].items()
                        ]
                elif path.endswith("/releases/7"):
                    if method == "PATCH":
                        state["release"].update(json.loads(body))
                        state["release"]["immutable"] = True
                    value = state["release"]
                else:
                    status = 404
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                if method != "HEAD":
                    self.wfile.write(
                        raw if raw is not None else json.dumps(value).encode()
                    )

            do_GET = do_POST = do_PUT = do_PATCH = do_HEAD = request

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(method, url, data=None, headers=None):
            parsed = urllib.parse.urlsplit(url)
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}"
                + parsed.path
                + ("?" + parsed.query if parsed.query else ""),
                data=data,
                method=method,
                headers=headers or {},
            )
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as e:
                response = e
            with response:
                return response.status, dict(response.headers), response.read()

        class API:
            def optional(self, path):
                code, _, body = request("GET", "http://owned" + path)
                if code == 404:
                    return None
                owner.assertEqual(code, 200)
                return json.loads(body)

            def json(self, path):
                return self.optional(path)

            def write(self, method, path, body):
                code, _, data = request(
                    method, "http://owned" + path, M.N.canonical(body)
                )
                M.N.require(code in [200, 201], "unknown write outcome; STOP")
                return json.loads(data)

            def upload(self, id, name, data):
                code, _, _ = request(
                    "POST",
                    f"http://owned{M.N.PREFIX}/releases/{id}/assets?name="
                    + urllib.parse.quote(name),
                    data,
                )
                M.N.require(code == 201, "unknown asset write; STOP")

        registry = M.Registry("owned", request)
        api = API()
        fences = []

        def fence():
            fences.append(1)

        try:
            # Valid control reaches actual OCI blob uploads/Git tag/draft/asset writes.
            result = M.publish(
                api, registry, files, images, fence, clock=lambda: T.F.NOW
            )
            self.assertEqual(
                owner.git("rev-parse", "refs/tags/v" + self.version), self.b
            )
            self.assertEqual(result["tag"], "v" + self.version)
            self.assertEqual(state["assets"], files)
            for role in M.Q.IMAGES:
                self.assertEqual(
                    registry.manifest(role, "preview"),
                    registry.manifest(role, self.version),
                )
            writes = len(state["writes"])
            M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertEqual(writes, len(state["writes"]))
            for role in M.Q.IMAGES:
                old = M.Q.decode(registry.manifest(role, self.version))
                old["annotations"] = {"org.opencontainers.image.version": "owned-old"}
                state["manifests"][registry.path(role, "/manifests/preview")] = (
                    M.N.canonical(old)
                )
            state["fail"] = "/v2/openconditions/contributions-api/manifests/preview"
            with self.assertRaisesRegex(ValueError, "registry write/read failed"):
                M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertFalse(state["release"]["draft"])
            self.assertEqual(
                registry.manifest("ingest", "preview"),
                registry.manifest("ingest", self.version),
            )
            self.assertNotEqual(
                registry.manifest("contributions-api", "preview"),
                registry.manifest("contributions-api", self.version),
            )
            state["fail"] = None
            M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            for role in M.Q.IMAGES:
                self.assertEqual(
                    registry.manifest(role, "preview"),
                    registry.manifest(role, self.version),
                )
            writes = len(state["writes"])
            altered = dict(files)
            altered["release-notes.md"] += b"drift"
            with self.assertRaisesRegex(ValueError, "asset changed"):
                M.publish(api, registry, altered, images, fence, clock=lambda: T.F.NOW)
            with self.assertRaisesRegex(ValueError, "expired"):
                M.publish(
                    api,
                    registry,
                    files,
                    images,
                    fence,
                    clock=lambda: T.F.NOW + timedelta(days=4),
                )
            self.assertEqual(writes, len(state["writes"]))
            state["assets"]["extension.json"] = b"conflict"
            state["release"].update(draft=True, immutable=False)
            version_path = registry.path("ingest", "/manifests/" + self.version)
            image_before = state["manifests"].pop(version_path)
            writes = len(state["writes"])
            with self.assertRaisesRegex(ValueError, "conflicting asset"):
                M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertEqual(
                writes,
                len(state["writes"]),
                "known asset conflict must stop before replacing missing version tag",
            )
            state["manifests"][version_path] = image_before
            state["release"].update(draft=False, immutable=True)
            state["assets"]["extension.json"] = files["extension.json"]
            # Fresh owned state; induce partial asset failure, verify preview never moves.
            owner.git("update-ref", "-d", "refs/tags/v" + self.version)
            state.update(
                release=None,
                assets={},
                manifests={},
                blobs={},
                writes=[],
                fail="/manifests/" + self.version,
            )
            with self.assertRaisesRegex(ValueError, "registry write/read failed"):
                M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertIsNone(state["release"])
            self.assertFalse(any(p.endswith("/preview") for p in state["manifests"]))
            state.update(
                release=None,
                assets={},
                manifests={},
                blobs={},
                writes=[],
                fail="/assets",
            )
            with self.assertRaisesRegex(ValueError, "unknown asset write"):
                M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertFalse(any(p.endswith("/preview") for p in state["manifests"]))
            state["fail"] = None
            M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertFalse(state["release"]["draft"])

            # Final native check rejection is not replaced by local good bytes.
            def reject():
                raise ValueError("post-approval authority changed")

            writes = len(state["writes"])
            with self.assertRaisesRegex(ValueError, "authority changed"):
                M.publish(api, registry, files, images, reject, clock=lambda: T.F.NOW)
            self.assertEqual(writes, len(state["writes"]))
            now = [T.F.NOW]

            def expire():
                now[0] += timedelta(days=4)

            with self.assertRaisesRegex(ValueError, "expired during final authority"):
                M.publish(api, registry, files, images, expire, clock=lambda: now[0])
            self.assertEqual(writes, len(state["writes"]))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    suite = unittest.TestSuite(
        [
            unittest.defaultTestLoader.loadTestsFromTestCase(Guards),
            Publication("test_publication_http_git_registry"),
        ]
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
