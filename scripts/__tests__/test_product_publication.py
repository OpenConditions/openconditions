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
    def test_actual_cli_rejects_fork_and_implicit_publication(self):
        env = {
            k: v for k, v in os.environ.items() if k not in ["GH_TOKEN", "GITHUB_TOKEN"]
        }
        env.update(T.F.ENV)
        env.update(
            GITHUB_EVENT_NAME="workflow_dispatch",
            GITHUB_REF="refs/heads/main",
            GITHUB_WORKFLOW_REF=M.N.REPO
            + "/.github/workflows/product-release.yml@refs/heads/main",
        )
        for change, message in [
            ({}, "explicit publish intent"),
            (
                {"GITHUB_REPOSITORY": "owned/fork", "RELEASE_OPERATION": "publish"},
                "untrusted qualification context",
            ),
        ]:
            result = subprocess.run(
                ["python3", "-B", str(Path(M.__file__))],
                env={**env, **change},
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)

    def test_standard_oci_command_preserves_digest_and_refuses_read_errors(self):
        with tempfile.TemporaryDirectory(prefix="oc-skopeo-adapter-") as temp:
            root = Path(temp)
            # Real process boundary: records argv, consumes original owned archive,
            # stores exact manifest. Actual skopeo qualification is separate.
            binary = root / "skopeo"
            binary.write_text(r"""#!/usr/bin/env python3
import sys,json,tarfile,pathlib
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (root/'calls').open('a') as f:f.write(json.dumps(args)+'\n')
if 'inspect' in args:
 p=root/('preview' if args[-1].endswith(':preview') else 'manifest')
 if not p.exists():sys.stderr.write('manifest unknown');sys.exit(1)
 sys.stdout.buffer.write(p.read_bytes())
else:
 src=args[-2]
 if src.startswith('oci-archive:'):
  with tarfile.open(src[12:]) as t:
   index=json.load(t.extractfile('index.json'))
   digest=index['manifests'][0]['digest'][7:]
   (root/'manifest').write_bytes(t.extractfile('blobs/sha256/'+digest).read())
 else:(root/'preview').write_bytes((root/'manifest').read_bytes())
""")
            binary.chmod(0o755)
            T.F.image_bundle(root / "image", "ingest")
            identity = M.Q.inspect_archive(root / "image/image.oci.tar")
            registry = M.Registry(root / "auth")
            with patch.dict(
                os.environ, {"PATH": str(root) + os.pathsep + os.environ["PATH"]}
            ):
                expected = identity["platformManifestDigest"]
                registry.promote(
                    "ingest", "1.0.0", root / "image/image.oci.tar", expected
                )
                registry.preview("ingest", "1.0.0", expected)
                calls = [
                    json.loads(x) for x in (root / "calls").read_text().splitlines()
                ]
                copies = [x for x in calls if "copy" in x]
                self.assertEqual(len(copies), 2)
                self.assertTrue(all("--preserve-digests" in x for x in copies))
                self.assertEqual(
                    copies[0][:4],
                    ["--override-os", "linux", "--override-arch", "amd64"],
                )
                with self.assertRaisesRegex(ValueError, "conflicting image"):
                    registry.promote(
                        "ingest",
                        "1.0.0",
                        root / "image/image.oci.tar",
                        "sha256:" + "0" * 64,
                    )
                binary.write_text("#!/bin/sh\necho unauthorized >&2\nexit 1\n")
                with self.assertRaisesRegex(ValueError, "not absence"):
                    registry.manifest("ingest", "1.0.0")


class Publication(T.ProductTests):
    def test_publication_artifact_admission(self):
        import io
        import zipfile

        q = self.qualify()
        rehearsal = {
            "execution": "passed (fixture)",
            "imageSourceSha": self.a,
            "manifestSourceSha": self.b,
            "services": {
                k: {"outcome": "passed"} for k in ["ingest", "contributions-api"]
            },
        }
        files = M.assets(
            self.repo,
            q,
            self.root,
            rehearsal,
            {"success": True, "numFailedTests": 0, "numPassedTests": 1},
            {},
        )

        def packed(values):
            data = io.BytesIO()
            with zipfile.ZipFile(data, "w") as archive:
                for name, body in values.items():
                    info = zipfile.ZipInfo("product-review/" + name)
                    info.external_attr = (0o100644) << 16
                    archive.writestr(info, body)
            return data.getvalue()

        self.add_artifact(888, "product-review-999-1", packed(files))
        artifact = self.artifacts[-1]
        artifact["workflow_run"].update(id=999, head_sha=self.b)
        artifact["created_at"] = T.F.END
        run = {**self.brun, "id": 999, "event": "workflow_dispatch", "workflow_id": 777}
        workflow = {
            "id": 777,
            "path": ".github/workflows/product-release.yml",
            "state": "active",
        }
        job = {
            "name": "qualify",
            "head_sha": self.b,
            "conclusion": "success",
            "steps": [
                {
                    "name": "Retain review artifact",
                    "conclusion": "success",
                    "status": "completed",
                    "started_at": T.F.START,
                    "completed_at": T.F.END,
                }
            ],
        }
        original = self.response
        reads = []

        def response(route):
            if route == M.N.PREFIX + "/actions/workflows/product-release.yml":
                value = workflow
            elif route in [
                M.N.PREFIX + "/actions/runs/999",
                M.N.PREFIX + "/actions/runs/999/attempts/1",
            ]:
                value = run
            elif (
                route
                == M.N.PREFIX + "/actions/runs/999/attempts/1/jobs?per_page=100&page=1"
            ):
                value = {"total_count": 1, "jobs": [job]}
            elif route == M.N.PREFIX + "/actions/artifacts/888":
                reads.append(1)
                value = copy.deepcopy(artifact)
                if getattr(self, "review_drift", False) and len(reads) % 2 == 0:
                    value["expired"] = True
            else:
                return original(route)
            return 200, {}, T.F.encoded(value)

        self.response = response

        def admit():
            with tempfile.TemporaryDirectory(prefix="oc-review-admission-") as temp:
                return M.admit(
                    self.api,
                    888,
                    artifact["digest"],
                    999,
                    1,
                    self.b,
                    Path(temp),
                    lambda: T.F.NOW,
                )

        self.assertEqual(admit(), files)
        for obj, change in [
            (run, {"head_sha": self.a}),
            (run, {"head_repository": {"id": 1}}),
            (run, {"run_attempt": 0}),
            (workflow, {"state": "disabled_manually"}),
            (job, {"conclusion": "failure"}),
            (artifact, {"expired": True}),
            (artifact, {"name": "other"}),
            (artifact, {"digest": "sha256:" + "0" * 64}),
        ]:
            with self.subTest(change=change):
                saved = copy.deepcopy(obj)
                obj.update(change)
                with self.assertRaises(ValueError):
                    admit()
                obj.clear()
                obj.update(saved)
        self.review_drift = True
        reads.clear()
        with self.assertRaisesRegex(ValueError, "artifact drift"):
            admit()
        self.review_drift = False
        for values in [
            {k: v for k, v in files.items() if k != "portable.json"},
            {**files, "extra": b"unknown"},
        ]:
            self.zips[888] = packed(values)
            artifact.update(
                digest="sha256:" + M.Q.sha(self.zips[888]),
                size_in_bytes=len(self.zips[888]),
            )
            with self.assertRaisesRegex(ValueError, "unexpected review paths"):
                admit()

    def test_publication_http_git_registry(self):
        q = self.qualify()
        rehearsal = {
            "execution": "passed (owned fixture only)",
            "imageSourceSha": self.a,
            "manifestSourceSha": self.b,
            "services": {
                k: {"outcome": "passed"} for k in ["ingest", "contributions-api"]
            },
        }
        rights = {"success": True, "numFailedTests": 0, "numPassedTests": 1}
        files = M.assets(
            self.repo,
            q,
            self.root,
            rehearsal,
            rights,
            {"kind": "owned portable fixture only"},
        )
        for changed in [{}, {**rights, "success": False}]:
            with self.assertRaises(ValueError):
                M.assets(self.repo, q, self.root, rehearsal, changed, {})
        with self.assertRaises(ValueError):
            M.assets(
                self.repo,
                q,
                self.root,
                {**rehearsal, "execution": "failed"},
                rights,
                {},
            )
        for name in ["scan.json", "sbom.cdx.json", "qualified.json"]:
            path = self.root / "ingest" / name
            original = path.read_bytes()
            path.write_bytes(b"{}")
            try:
                with self.assertRaisesRegex(ValueError, "report bytes changed"):
                    M.assets(self.repo, q, self.root, rehearsal, rights, {})
            finally:
                path.write_bytes(original)
        images = self.root
        state = {
            "release": None,
            "assets": {},
            "manifests": {},
            "blobs": {},
            "writes": [],
            "fail": None,
        }
        owner = self

        upload_locations = {
            "/v2/openconditions/ingest/blobs/uploads/": "/v2/openconditions/ingest/blobs/uploads/owned",
            "/v2/openconditions/contributions-api/blobs/uploads/": "/v2/openconditions/contributions-api/blobs/uploads/owned",
            "/v2/openconditions/federation/blobs/uploads/": "/v2/openconditions/federation/blobs/uploads/owned",
            "/v2/openconditions/openlr-resolver/blobs/uploads/": "/v2/openconditions/openlr-resolver/blobs/uploads/owned",
        }

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
                        if method == "POST" and path in upload_locations:
                            status = 202
                            headers["Location"] = upload_locations[path]
                        else:
                            status = 404
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

        class OwnedRegistry:
            # Test-only HTTP adapter uses real tar bytes; the production adapter
            # invokes standard skopeo (tested separately), no registry reimplementation.
            def path(self, role, suffix):
                return "/v2/openconditions/" + role + suffix

            def manifest(self, role, tag):
                code, _, body = request(
                    "GET", "http://owned" + self.path(role, "/manifests/" + tag)
                )
                M.N.require(code in [200, 404], "registry read failed")
                return body if code == 200 else None

            def promote(self, role, version, archive, expected):
                if self.manifest(role, version) is not None:
                    return
                import tarfile

                with tarfile.open(archive) as tar:
                    body = tar.extractfile("blobs/sha256/" + expected[7:]).read()
                code, _, _ = request(
                    "PUT",
                    "http://owned" + self.path(role, "/manifests/" + version),
                    body,
                )
                M.N.require(code == 201, "registry write/read failed")

            def preview(self, role, version, expected):
                body = self.manifest(role, version)
                if self.manifest(role, "preview") == body:
                    return
                code, _, _ = request(
                    "PUT", "http://owned" + self.path(role, "/manifests/preview"), body
                )
                M.N.require(code == 201, "registry write/read failed")

        registry = OwnedRegistry()
        api = API()
        fences = []

        def fence():
            fences.append(1)

        try:
            for role in M.Q.IMAGES:
                route = f"/v2/openconditions/{role}/blobs/uploads/"
                code, headers, _ = request("POST", "http://owned" + route, b"")
                self.assertEqual(code, 202)
                self.assertEqual(headers.get("Location"), route + "owned")
            for route in [
                "/v2/unowned/blobs/uploads/",
                "/v2/openconditions/ingest/extra/blobs/uploads/",
            ]:
                code, headers, _ = request("POST", "http://owned" + route, b"")
                self.assertEqual(
                    code,
                    404,
                    "unknown upload route must not gain response-header authority",
                )
                self.assertNotIn("Location", headers)
            # Valid control reaches actual OCI blob uploads/Git tag/draft/asset writes.
            result = M.publish(
                api, registry, files, images, fence, clock=lambda: T.F.NOW
            )
            self.assertEqual(
                owner.git("rev-parse", "refs/tags/v" + self.version), self.b
            )
            self.assertEqual(result, "v" + self.version)
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

            # Owner immutability setup is not an admin-read dependency. Its
            # actual published-release readback must hold before any preview.
            for role in M.Q.IMAGES:
                state["manifests"].pop(registry.path(role, "/manifests/preview"))
            state["release"]["immutable"] = False
            writes = len(state["writes"])
            with self.assertRaisesRegex(ValueError, "not immutable; preview unchanged"):
                M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)
            self.assertEqual(writes, len(state["writes"]))
            self.assertFalse(any(p.endswith("/preview") for p in state["manifests"]))
            state["release"]["immutable"] = True
            M.publish(api, registry, files, images, fence, clock=lambda: T.F.NOW)

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

            with self.assertRaisesRegex(ValueError, "expired publication evidence"):
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
            unittest.TestSuite(
                Publication(n)
                for n in unittest.defaultTestLoader.getTestCaseNames(Publication)
                if n.startswith("test_publication_")
            ),
        ]
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
