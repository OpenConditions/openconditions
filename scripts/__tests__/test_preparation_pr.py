"""Real Git trees/owned archives with native HTTP reads and a local REST write adapter."""

import copy
from datetime import timedelta
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile
import test_product_qualification as T

SPEC = importlib.util.spec_from_file_location(
    "pr", T.P.TOOLS / "scripts/create-product-preparation-pr.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class PreparationTests(T.ProductTests):
    def setUp(self):
        super().setUp()
        b = self.b
        self.files = {
            p: T.P.git(self.repo, "show", f"{b}:{p}")
            for p in [
                "extension.json",
                *[
                    f"services/{s}/service.json"
                    for s in [
                        "ingest",
                        "ingest-heavy",
                        "contributions-api",
                        "federation",
                    ]
                ],
                f"docs/release-notes/{self.version}.json",
                f"docs/release-notes/{self.version}.md",
            ]
        }
        self.tree = self.git("rev-parse", b + "^{tree}")
        self.b = self.a
        self.brun = copy.deepcopy(self.run)
        self.git("checkout", "--detach", self.a)
        self.remote = self.root / "remote.git"
        subprocess.run(
            ["git", "clone", "--bare", str(self.repo), str(self.remote)],
            check=True,
            capture_output=True,
        )
        self.proof = {
            "version": self.version,
            "imageSourceSha": self.a,
            "metadataSha256": {p: T.P.N.Q.sha(v) for p, v in self.files.items()},
            "images": self.native["images"],
            "contextProof": {"equal": True},
            "preparedTreeOid": self.tree,
            "historySha256": hashlib.sha256(
                json.dumps(["v0.7.0", "v0.7.0"], separators=(",", ":")).encode()
            ).hexdigest(),
        }
        receipt = {
            "kind": "Native A preparation binding only",
            "releaseAuthority": False,
            "nativeBQualified": False,
            "nativeImageEvidence": self.native,
            "localProof": self.proof,
            "eligibleUntil": self.native["eligibleUntil"],
        }
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for p, v in {
                **{"product-review/" + p: v for p, v in self.files.items()},
                "product-review.receipt.json": json.dumps(receipt).encode(),
            }.items():
                info = zipfile.ZipInfo(p)
                info.create_system = 3
                info.external_attr = (0o100644) << 16
                z.writestr(info, v)
        self.archive = buf.getvalue()
        self.upload = {
            "id": 900,
            "name": "product-review-800-1",
            "digest": "sha256:" + hashlib.sha256(self.archive).hexdigest(),
            "size_in_bytes": len(self.archive),
            "expired": False,
            "expires_at": self.native["eligibleUntil"],
            "workflow_run": {"id": 800, "head_sha": self.a},
        }
        self.now = T.F.NOW
        self.posts = []
        self.ref = None
        self.prs = []
        self.commits = {}
        original = self.response

        def response(route):
            if route == M.N.PREFIX + "/actions/artifacts/900":
                return 200, {}, T.F.encoded(self.upload)
            if route == M.N.PREFIX + "/actions/runs/800":
                return (
                    200,
                    {},
                    T.F.encoded(
                        {
                            "id": 800,
                            "head_sha": self.a,
                            "head_branch": "main",
                            "event": "workflow_dispatch",
                            "run_attempt": 1,
                            "path": ".github/workflows/product-release.yml",
                            "repository": {"id": M.N.REPO_ID},
                        }
                    ),
                )
            if (
                route
                == M.N.PREFIX + "/actions/runs/800/attempts/1/jobs?per_page=100&page=1"
            ):
                return (
                    200,
                    {},
                    T.F.encoded(
                        {
                            "total_count": 1,
                            "jobs": [
                                {
                                    "name": "qualify",
                                    "status": "completed",
                                    "conclusion": "success",
                                }
                            ],
                        }
                    ),
                )
            return original(route)

        self.response = response
        owner = self

        class Adapter:
            def json(self, route):
                if "/git/commits/" in route:
                    sha = route.rsplit("/", 1)[1]
                    if sha == owner.a:
                        return {
                            "sha": sha,
                            "tree": {"sha": owner.git("rev-parse", sha + "^{tree}")},
                        }
                    return owner.commits[sha]
                if "/pulls?" in route:
                    return copy.deepcopy(owner.prs)
                if route.endswith("/pulls/42"):
                    return copy.deepcopy(owner.prs[0])
                return owner.api.json(route)

            def pages(self, *args):
                return owner.api.pages(*args)

            def optional(self, route):
                return copy.deepcopy(owner.ref)

            def download(self, artifact, path):
                path.write_bytes(owner.archive)

            def mutate(self, route, body):
                owner.posts.append((route, copy.deepcopy(body)))
                if route.endswith("/git/trees"):
                    owner.assertEqual(
                        {x["path"] for x in body["tree"]}, set(owner.files)
                    )
                    owner.assertTrue(
                        all(
                            x["mode"] == "100644" and x["type"] == "blob"
                            for x in body["tree"]
                        )
                    )
                    with tempfile.TemporaryDirectory() as temp:
                        env = {
                            **os.environ,
                            "GIT_INDEX_FILE": str(Path(temp) / "index"),
                        }

                        def git(*args, input=None):
                            return (
                                subprocess.check_output(
                                    ["git", "--git-dir", str(owner.remote), *args],
                                    env=env,
                                    input=input,
                                )
                                .decode()
                                .strip()
                            )

                        owner.assertEqual(
                            body["base_tree"],
                            owner.git("rev-parse", owner.a + "^{tree}"),
                        )
                        git("read-tree", body["base_tree"])
                        for x in body["tree"]:
                            oid = git(
                                "hash-object",
                                "-w",
                                "--stdin",
                                input=x["content"].encode(),
                            )
                            git(
                                "update-index",
                                "--add",
                                "--cacheinfo",
                                "100644",
                                oid,
                                x["path"],
                            )
                        return {"sha": git("write-tree")}
                if route.endswith("/git/commits"):
                    owner.assertEqual(body["parents"], [owner.a])
                    owner.assertEqual(body["author"]["name"], "github-actions[bot]")
                    sha = (
                        subprocess.check_output(
                            [
                                "git",
                                "--git-dir",
                                str(owner.remote),
                                "-c",
                                "commit.gpgsign=false",
                                "commit-tree",
                                body["tree"],
                                "-p",
                                owner.a,
                                "-m",
                                body["message"],
                            ]
                        )
                        .decode()
                        .strip()
                    )
                    owner.commits[sha] = {
                        "sha": sha,
                        "tree": {"sha": body["tree"]},
                        "parents": [{"sha": owner.a}],
                        "message": body["message"],
                    }
                    return {"sha": sha}
                if route.endswith("/git/refs"):
                    owner.assertIsNone(owner.ref)
                    owner.assertEqual(
                        body["ref"], "refs/heads/release/prepare-" + owner.version
                    )
                    subprocess.run(
                        [
                            "git",
                            "--git-dir",
                            str(owner.remote),
                            "update-ref",
                            body["ref"],
                            body["sha"],
                        ],
                        check=True,
                    )
                    owner.ref = {"ref": body["ref"], "object": {"sha": body["sha"]}}
                    return copy.deepcopy(owner.ref)
                if route.endswith("/pulls"):
                    owner.assertEqual(body["base"], "main")
                    owner.assertIs(body["draft"], False)
                    owner.prs = [
                        {
                            **body,
                            "user": {"login": "github-actions[bot]"},
                            "state": "open",
                            "merged_at": None,
                            "auto_merge": None,
                            "number": 42,
                            "html_url": "https://github.com/OpenConditions/openconditions/pull/42",
                            "head": {
                                "sha": owner.ref["object"]["sha"],
                                "ref": body["head"],
                                "repo": {"full_name": M.N.REPO},
                            },
                            "base": {"ref": "main", "sha": owner.a},
                            "assignees": [],
                            "labels": [],
                        }
                    ]
                    return copy.deepcopy(owner.prs[0])
                if route.endswith("/assignees"):
                    owner.prs[0]["assignees"] = [{"login": "Medformatik"}]
                    return {}
                if route.endswith("/labels"):
                    owner.prs[0]["labels"] = [{"name": n} for n in body["labels"]]
                    return {}
                raise AssertionError(route)

        self.adapter = Adapter()

    def create(self):
        return M.create(
            self.adapter,
            self.repo,
            self.a,
            900,
            self.upload["digest"],
            800,
            1,
            clock=lambda: self.now,
        )

    def test_preparation_positive_retry_conflict(self):
        index = (self.repo / ".git/index").read_bytes()
        head = self.git("rev-parse", "HEAD")
        url = self.create()
        self.assertTrue(url.endswith("/42"))
        self.assertEqual(len(self.posts), 6)
        self.assertEqual(index, (self.repo / ".git/index").read_bytes())
        self.assertEqual(head, self.git("rev-parse", "HEAD"))
        self.assertEqual(self.create(), url)
        self.assertEqual(len(self.posts), 6)
        self.prs[0]["user"]["login"] = "human"
        with self.assertRaisesRegex(ValueError, "human"):
            self.create()
        self.assertEqual(len(self.posts), 6)
        self.prs[0]["user"]["login"] = "github-actions[bot]"
        self.commits[self.ref["object"]["sha"]]["tree"]["sha"] = "1" * 40
        with self.assertRaisesRegex(ValueError, "content conflict"):
            self.create()
        self.assertEqual(len(self.posts), 6)

    def test_preparation_fences_before_writes(self):
        self.upload["expired"] = True
        with self.assertRaisesRegex(ValueError, "artifact identity"):
            self.create()
        self.assertEqual(self.posts, [])
        self.upload["expired"] = False
        self.b = "1" * 40
        with self.assertRaisesRegex(ValueError, "Main advanced"):
            self.create()
        self.assertEqual(self.posts, [])
        self.b = self.a
        self.brun["id"] = 999
        with self.assertRaisesRegex(ValueError, "latest"):
            self.create()
        self.brun["id"] = 123
        self.assertEqual(self.posts, [])
        self.ref = {"object": {"sha": "1" * 40}}
        with self.assertRaisesRegex(ValueError, "human branch"):
            self.create()
        self.assertEqual(self.posts, [])

    def test_preparation_payload_drift(self):
        real = self.adapter.mutate

        def mutate(route, body):
            result = real(route, body)
            if route.endswith("/git/commits"):
                self.upload["expired"] = True
            return result

        self.adapter.mutate = mutate
        with self.assertRaisesRegex(ValueError, "changed"):
            self.create()
        self.assertEqual(
            [p.rsplit("/", 1)[1] for p, _ in self.posts], ["trees", "commits"]
        )
        self.assertIsNone(self.ref)

    def test_preparation_archive_rejections(self):
        original = self.archive
        for change in ["extra", "missing", "mode", "symlink", "bytes", "duplicate"]:
            buf = io.BytesIO()
            with (
                zipfile.ZipFile(io.BytesIO(original)) as src,
                zipfile.ZipFile(buf, "w") as z,
            ):
                for info in src.infolist():
                    data = src.read(info)
                    if info.filename == "product-review/extension.json":
                        if change == "missing":
                            continue
                        if change == "mode":
                            info.external_attr = 0o100755 << 16
                        if change == "symlink":
                            info.external_attr = 0o120644 << 16
                        if change == "bytes":
                            data = b"{}"
                    z.writestr(info, data)
                if change == "extra":
                    z.writestr("../outside", b"no")
                if change == "duplicate":
                    z.writestr("product-review/extension.json", b"{}")
            self.archive = buf.getvalue()
            self.upload["digest"] = "sha256:" + hashlib.sha256(self.archive).hexdigest()
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.create()
            self.assertEqual(self.posts, [])

    def test_preparation_unknown_write_stops(self):
        real = self.adapter.mutate

        def mutate(route, body):
            result = real(route, body)
            if route.endswith("/git/refs"):
                raise OSError("unknown response after owned remote effect")
            return result

        self.adapter.mutate = mutate
        with self.assertRaises(OSError):
            self.create()
        self.assertEqual(len(self.posts), 3)
        self.assertIsNotNone(self.ref)
        self.assertFalse(self.prs)
        with self.assertRaisesRegex(ValueError, "orphan/human"):
            self.create()
        self.assertEqual(len(self.posts), 3)

    def test_preparation_wrong_tree_stops_before_branch(self):
        real = self.adapter.mutate

        def mutate(route, body):
            result = real(route, body)
            if route.endswith("/git/trees"):
                result["sha"] = "1" * 40
            return result

        self.adapter.mutate = mutate
        with self.assertRaisesRegex(ValueError, "Prepared tree differs"):
            self.create()
        self.assertEqual(len(self.posts), 1)
        self.assertIsNone(self.ref)

    def test_preparation_expiry_before_branch(self):
        real = self.adapter.mutate

        def mutate(route, body):
            result = real(route, body)
            if route.endswith("/git/trees"):
                self.now += timedelta(days=4)
            return result

        self.adapter.mutate = mutate
        with self.assertRaisesRegex(ValueError, "expired/changed"):
            self.create()
        self.assertEqual(len(self.posts), 1)
        self.assertIsNone(self.ref)


if __name__ == "__main__":
    suite = unittest.TestSuite(
        PreparationTests(n)
        for n in unittest.defaultTestLoader.getTestCaseNames(PreparationTests)
        if n.startswith("test_preparation_")
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
