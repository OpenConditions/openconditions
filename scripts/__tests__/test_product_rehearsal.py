"""Owned real PostgreSQL recovery and fail-closed rehearsal controls."""

import importlib.util
from pathlib import Path
import subprocess
import unittest
import uuid
import test_product_qualification as T
from unittest.mock import patch
from datetime import timedelta

SPEC = importlib.util.spec_from_file_location(
    "rehearsal", Path(__file__).resolve().parents[1] / "rehearse-product-release.py"
)
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)


class RecoveryTests(unittest.TestCase):
    def test_real_recovery(self):
        name = "oc-recovery-test-" + uuid.uuid4().hex
        q = R.Q
        q.command(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--label",
                f"openconditions.qualification={name}",
                "--network",
                "none",
                "-e",
                "POSTGRES_PASSWORD=fixture",
                q.POSTGIS,
            ]
        )
        try:
            sql = [
                "docker",
                "exec",
                name,
                "psql",
                "-h",
                "127.0.0.1",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-Atqc",
            ]
            # pg_isready is bounded inside the owned container, never a live DB.
            q.command(
                [
                    "docker",
                    "exec",
                    name,
                    "sh",
                    "-ec",
                    "for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -U postgres && exit 0; sleep 1; done; exit 1",
                ],
                timeout=70,
            )
            q.command(
                [
                    *sql,
                    "CREATE SCHEMA conditions; CREATE TABLE conditions.fixture(x text); INSERT INTO conditions.fixture VALUES ('owned');",
                ]
            )
            restored = R.recover(name, "postgres", "postgres", q.command)
            self.assertIn("owned-schema-loss-confirmed", restored.stdout)
            self.assertEqual(
                q.command([*sql, "SELECT x FROM conditions.fixture"]).stdout.strip(),
                "owned",
            )

            def broken_restore(args, **kwargs):
                args = [
                    a.replace("pg_restore -U", "false # pg_restore -U")
                    if isinstance(a, str)
                    else a
                    for a in args
                ]
                return q.command(args, **kwargs)

            with self.assertRaises(ValueError):
                R.recover(name, "postgres", "postgres", broken_restore)
            self.assertEqual(
                q.command(
                    [*sql, "SELECT to_regnamespace('conditions') IS NULL"]
                ).stdout.strip(),
                "t",
            )
        finally:
            result = q.remove_owned("container", name, name)
            self.assertTrue(result["absent"])

    def test_recovery_command_failure(self):
        calls = []

        def failing(args, **kwargs):
            calls.append(args)
            raise subprocess.CalledProcessError(1, args)

        with self.assertRaises(subprocess.CalledProcessError):
            R.recover("owned-db", "fixture", "fixture", failing)
        self.assertEqual(len(calls), 1)


class NativeTests(T.ProductTests):
    def test_rehearsal_native_fences(self):
        q = self.qualify()
        output = self.root / "rehearsal"

        def runtime(role, identity, source, directory, **kwargs):
            R.Q.write_json(
                directory / "runtime.json",
                {
                    "passed": True,
                    "checks": {"backupRestoreRecovery": {"outcome": "passed"}},
                },
            )

        with patch.object(R.Q, "runtime_smoke", runtime):
            result = R.run(self.api, self.repo, q, output, clock=lambda: T.F.NOW)
        self.assertEqual(set(result["services"]), {"ingest", "contributions-api"})
        self.assertFalse(result["releaseAuthority"])
        self.assertIn("actual prior-deployment", " ".join(result["limitations"]))
        with self.assertRaises(FileExistsError):
            R.run(self.api, self.repo, q, output, clock=lambda: T.F.NOW)
        with self.assertRaises(ValueError):
            R.run(
                self.api,
                self.repo,
                q,
                self.root / "expired",
                clock=lambda: T.F.NOW + timedelta(days=4),
            )
        self.assertFalse((self.root / "expired").exists())

    def test_rehearsal_final_drift(self):
        q = self.qualify()
        output = self.root / "drift"
        original = R.P.final_fences
        calls = []

        def fence(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise ValueError("source authority changed")
            return original(*args, **kwargs)

        def runtime(role, identity, source, directory, **kwargs):
            R.Q.write_json(
                directory / "runtime.json",
                {
                    "passed": True,
                    "checks": {"backupRestoreRecovery": {"outcome": "passed"}},
                },
            )

        with (
            patch.object(R.Q, "runtime_smoke", runtime),
            patch.object(R.P, "final_fences", fence),
            self.assertRaisesRegex(ValueError, "source authority changed"),
        ):
            R.run(self.api, self.repo, q, output, clock=lambda: T.F.NOW)
        self.assertEqual(
            R.Q.json_file(output / "rehearsal.json")["execution"], "failed"
        )

    def test_rehearsal_runtime_failure(self):
        q = self.qualify()
        output = self.root / "failure"

        def failed(*args, **kwargs):
            raise ValueError("owned runtime failed")

        with (
            patch.object(R.Q, "runtime_smoke", failed),
            self.assertRaisesRegex(ValueError, "owned runtime failed"),
        ):
            R.run(self.api, self.repo, q, output, clock=lambda: T.F.NOW)
        result = R.Q.json_file(output / "rehearsal.json")
        self.assertEqual(result["execution"], "failed")
        self.assertFalse(result["releaseAuthority"])
        self.assertFalse((output / "ingest-rehearsal/image.oci.tar").exists())


if __name__ == "__main__":
    suite = unittest.TestSuite(
        [
            unittest.defaultTestLoader.loadTestsFromTestCase(RecoveryTests),
            unittest.TestSuite(
                NativeTests(n)
                for n in unittest.defaultTestLoader.getTestCaseNames(NativeTests)
                if n.startswith("test_rehearsal_")
            ),
        ]
    )
    raise SystemExit(
        not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    )
