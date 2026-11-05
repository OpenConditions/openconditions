"""Real owning HTTP/Git fixture discovery, no public release execution."""

import copy
import importlib.util
import unittest
import subprocess
from unittest.mock import patch
import test_product_qualification as T

SPEC = importlib.util.spec_from_file_location(
    "flow", T.P.TOOLS / "scripts/product-release-flow.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class FlowTests(T.ProductTests):
    def test_flow_discovery_and_summary(self):
        self.assertEqual(M.discover(self.api, self.b, lambda: T.F.NOW), (456, 1))
        for change in [
            {"status": "in_progress"},
            {"event": "pull_request"},
            {"head_sha": self.a},
            {"run_attempt": 2},
        ]:
            original = copy.deepcopy(self.brun)
            self.brun.update(change)
            with self.assertRaises(ValueError):
                M.discover(self.api, self.b, lambda: T.F.NOW)
            self.brun = original
        text = M.summary("review", self.version, self.b)
        self.assertIn("Publish: explicit intent", text)
        self.assertIn("Not exercised: production upgrade", text)
        self.assertNotIn("BLOCKED_NO_TRUSTED_PRODUCER", text)
        self.assertIn(
            "Blocked: main CI pending",
            M.summary("review", self.version, self.b, "main CI pending"),
        )

    def test_flow_composes_native_review_and_complete_assets(self):
        original = subprocess.run
        portable = []

        def command(args, **kwargs):
            if len(args) > 1 and args[1].endswith("validate-product-manifests.mjs"):
                portable.append(args)
                # Controlled external portable boundary only. Existing actual
                # pinned-tool tests prove that contract; native/Git/context and
                # asset/recovery orchestration here execute their real paths.
                return subprocess.CompletedProcess(
                    args, 0, b'{"ownedPortableBoundary":true}', b""
                )
            return original(args, **kwargs)

        def runtime(role, identity, source, directory, **kwargs):
            self.assertIs(kwargs["exercise"], M.R.exercise)
            M.Q.write_json(
                directory / "runtime.json",
                {
                    "passed": True,
                    "checks": {"backupRestoreRecovery": {"outcome": "passed"}},
                },
            )

        output = self.root / "review-output"
        before = (self.repo / ".git/index").read_bytes()
        with (
            patch.object(M.subprocess, "run", command),
            patch.object(M.R.Q, "runtime_smoke", runtime),
        ):
            q = M.execute(
                self.api,
                self.repo,
                self.b,
                "review",
                self.version,
                "",
                self.root / "owned-tools",
                output,
                clock=lambda: T.F.NOW,
                rights={"success": True, "numFailedTests": 0, "numPassedTests": 1},
            )
        files = {p.name: p.read_bytes() for p in output.iterdir()}
        self.assertEqual(M.PUB.verify(files), q)
        self.assertEqual(set(files), M.PUB.ASSETS | {"release.json"})
        self.assertEqual(len(portable), 1)
        self.assertEqual((self.repo / ".git/index").read_bytes(), before)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(
            T.json.loads(files["portable.json"]), {"ownedPortableBoundary": True}
        )

        def failed(*args, **kwargs):
            raise ValueError("owned recovery failed")

        with (
            patch.object(M.R.Q, "runtime_smoke", failed),
            self.assertRaisesRegex(ValueError, "owned recovery failed"),
        ):
            M.execute(
                self.api,
                self.repo,
                self.b,
                "publish",
                self.version,
                "",
                self.root / "owned-tools",
                self.root / "failed-output",
                clock=lambda: T.F.NOW,
                rights={"success": True, "numFailedTests": 0, "numPassedTests": 1},
            )
        self.assertFalse((self.root / "failed-output").exists())

    def test_flow_rejects_unsupported_operation(self):
        with self.assertRaisesRegex(ValueError, "unsupported operation"):
            M.execute(
                self.api,
                self.repo,
                self.b,
                "automatic",
                self.version,
                "",
                None,
                self.root / "output",
            )


if __name__ == "__main__":
    suite = unittest.TestSuite(
        FlowTests(n)
        for n in unittest.defaultTestLoader.getTestCaseNames(FlowTests)
        if n.startswith("test_flow_")
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
