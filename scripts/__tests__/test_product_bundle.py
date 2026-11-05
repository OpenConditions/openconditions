"""Owned local review bundles; synthetic native responses are not release authority."""

import copy
import importlib.util
import json
import subprocess
import unittest
import test_product_qualification as T

SPEC = importlib.util.spec_from_file_location(
    "bundle", T.P.TOOLS / "scripts/bundle-product-release.py"
)
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)


class BundleTests(T.ProductTests):
    def setUp(self):
        super().setUp()
        self.q = self.qualify()
        self.readiness = {
            "schemaVersion": 1,
            "imageSourceSha": self.a,
            "manifestSourceSha": self.b,
            "images": {
                k: v["digest"] for k, v in self.q["imageEvidence"]["images"].items()
            },
            "platform": "linux/amd64",
            "postgresMajor": 16,
            "priorDeployment": {
                "identity": "owned-prior-fixture",
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
                        "name": "owned-fixture",
                        "version": "1",
                        "sha256": "4" * 64,
                    },
                    "evidenceSha256": "5" * 64,
                }
                for k in B.STEPS
            },
        }

    def test_bundle_readiness(self):
        B.readiness_claim(self.readiness, self.q, T.F.NOW)
        for mutation in [
            lambda r: r["steps"].pop("backupRestoreRecovery"),
            lambda r: r["steps"]["cleanInstall"].update(outcome="failed"),
            lambda r: r.update(manifestSourceSha=self.a),
            lambda r: r.update(approved=True),
            lambda r: r["priorDeployment"].update(identity=""),
            lambda r: r["steps"]["upgradeMigration"].update(outcome="not_applicable"),
        ]:
            r = copy.deepcopy(self.readiness)
            mutation(r)
            with self.assertRaises(ValueError):
                B.readiness_claim(r, self.q, T.F.NOW)

    def test_bundle_inventory(self):
        output = self.repo.parent / (self.repo.name + "-bundle")
        try:
            files = {"owned.json": b"{}\n"}
            B.emit(output, files)
            B.verify_directory(output, files)
            with self.assertRaises(FileExistsError):
                B.emit(output, files)
            (output / "extra").mkdir()
            with self.assertRaises(ValueError):
                B.verify_directory(output, files)
            (output / "extra").rmdir()
            (output / "owned.json").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                B.verify_directory(output, files)
            (output / "owned.json").unlink()
            (output / "owned.json").symlink_to(self.repo / "extension.json")
            with self.assertRaises((ValueError, OSError)):
                B.verify_directory(output, files)
            (output / "owned.json").unlink()
            (output / "owned.json").write_bytes(files["owned.json"])
            (output / "owned.json").chmod(0o755)
            with self.assertRaises(ValueError):
                B.verify_directory(output, files)
            for bad in ["../escape", "/absolute", "a/../../escape"]:
                with self.assertRaises(ValueError):
                    B.emit(output.parent / "never-created", {bad: b"x"})
        finally:
            import shutil

            if output.exists():
                shutil.rmtree(output)

    def test_bundle_metadata_and_claim_authority(self):
        files = B.bundle_files(self.repo, self.q, self.readiness, T.F.NOW)
        self.assertEqual(len(files), 11)
        m = json.loads(files["bundle.json"])
        self.assertFalse(m["releaseAuthority"])
        self.assertEqual(m["readinessExecution"], "BLOCKED_NO_TRUSTED_PRODUCER")
        self.assertEqual(m["nativeQualification"], "NOT_ESTABLISHED_BY_LOCAL_BUNDLE")
        B.validate_inventory(files)
        manifest = json.loads(files["bundle.json"])
        manifest["tagTargetSha"] = self.a
        wrong = {**files, "bundle.json": json.dumps(manifest).encode()}
        with self.assertRaises(ValueError):
            B.validate_inventory(wrong)
        bad = dict(files)
        bad.pop("extension.json")
        with self.assertRaises(ValueError):
            B.validate_inventory(bad)
        q = copy.deepcopy(self.q)
        q["tagTargetSha"] = self.a
        with self.assertRaises(ValueError):
            B.bundle_files(self.repo, q, self.readiness, T.F.NOW)
        with self.assertRaises(ValueError):
            B.bundle_files(
                self.repo, self.q, self.readiness, T.F.NOW.replace(year=2030)
            )

    def test_bundle_cli_untrusted_native_context(self):
        p = subprocess.run(
            ["python3", "-B", str(B.__file__), "--native"],
            capture_output=True,
            env={"PATH": __import__("os").environ["PATH"]},
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b"untrusted qualification context", p.stderr)


if __name__ == "__main__":
    suite = unittest.TestSuite(
        BundleTests(n)
        for n in unittest.defaultTestLoader.getTestCaseNames(BundleTests)
        if n.startswith("test_bundle_")
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
