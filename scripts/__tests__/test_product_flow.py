"""Real owning HTTP/Git fixture discovery, no public release execution."""

import copy
import importlib.util
import unittest
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
        self.assertIn(
            "pending", M.summary("prepare", self.version, self.a, "Actions artifact")
        )
        self.assertNotIn(
            '"releaseAuthority"',
            M.summary("review", self.version, self.b, "Actions artifact"),
        )

        self.assertIn(
            "Tests and images: verified",
            M.summary("prepare", self.version, self.a, "artifact"),
        )
        self.assertIn(
            "Manifest compatibility: not verified",
            M.summary("review", self.version, self.b, "none", "Pending main CI"),
        )

    def test_flow_pending_not_approval(self):
        spec = importlib.util.spec_from_file_location(
            "bundle", T.P.TOOLS / "scripts/bundle-product-release.py"
        )
        b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b)
        files = b.bundle_files(self.repo, self.qualify(), None, T.F.NOW)
        m = T.json.loads(files["bundle.json"])
        self.assertEqual(m["readinessContent"], "PENDING")
        self.assertEqual(m["readinessExecution"], "BLOCKED_NO_TRUSTED_PRODUCER")
        self.assertFalse(m["releaseAuthority"])


if __name__ == "__main__":
    suite = unittest.TestSuite(
        FlowTests(n)
        for n in unittest.defaultTestLoader.getTestCaseNames(FlowTests)
        if n.startswith("test_flow_")
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
