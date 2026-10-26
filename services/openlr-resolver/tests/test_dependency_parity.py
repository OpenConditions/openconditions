# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Exercise dependency checks as real read-only commands over independent files."""

import hashlib
import subprocess
import sys
from pathlib import Path

import pytest

CHECK = Path(__file__).resolve().parents[1] / "scripts" / "check_dependencies.py"
HASH = " --hash=sha256:" + "a" * 64


@pytest.fixture
def dependency_root(tmp_path):
    root = tmp_path / "dependencies ü"
    root.mkdir()
    (root / "requirements.in").write_text("demo[fast]==1.0\n")
    (root / "requirements-build.in").write_text("builder==1.0\n")
    (root / "requirements-build.txt").write_text("builder==1.0" + HASH + "\ncore==4.0" + HASH + "\n")
    (root / "requirements-dev.in").write_text("-r requirements.txt\npytest==9.1.1\n")
    (root / "requirements.txt").write_text("demo[fast]==1.0" + HASH + "\ncore==4.0" + HASH + "\n")
    (root / "requirements-dev.txt").write_text(
        (root / "requirements.txt").read_text() + "pytest==9.1.1" + HASH + "\n"
    )
    (root / "pyproject.toml").write_text(
        '[project]\nrequires-python = ">=3.12"\ndependencies = ["demo[fast]==1.0"]\n'
        '[project.optional-dependencies]\ndev = ["pytest==9.1.1"]\nbuild = ["builder==1.0"]\n'
    )
    return root


def run_check(root):
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
    result = subprocess.run(
        [sys.executable, str(CHECK), "--root", str(root)], capture_output=True, text=True
    )
    assert {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()} == before
    return result


def test_accepts_matching_inputs_metadata_and_complete_hash_locks(dependency_root):
    result = run_check(dependency_root)
    assert result.returncode == 0, result.stderr


def test_changed_authoritative_input_cannot_use_a_stale_lock(dependency_root):
    for name in ["requirements.in", "pyproject.toml"]:
        path = dependency_root / name
        path.write_text(path.read_text().replace("demo[fast]==1.0", "demo[fast]==2.0"))
    result = run_check(dependency_root)
    assert result.returncode == 1
    assert "requirements.txt" in result.stderr and "demo" in result.stderr


@pytest.mark.parametrize("field", ["demo[fast]==1.0", "pytest==9.1.1"])
def test_conflicting_project_metadata_fails(dependency_root, field):
    path = dependency_root / "pyproject.toml"
    path.write_text(path.read_text().replace(field, field.replace("==", "==2")))
    result = run_check(dependency_root)
    assert result.returncode == 1
    assert "pyproject" in result.stderr


@pytest.mark.parametrize("include", ["", "-r requirements.in\n", "-c requirements.txt\n"])
def test_dev_input_must_include_the_runtime_hash_lock(dependency_root, include):
    (dependency_root / "requirements-dev.in").write_text(include + "pytest==9.1.1\n")
    result = run_check(dependency_root)
    assert result.returncode == 1
    assert "include" in result.stderr


def test_dev_metadata_cannot_omit_a_direct_audit_tool(dependency_root):
    path = dependency_root / "requirements-dev.in"
    path.write_text(path.read_text() + "pip-audit==2.10.1\n")
    result = run_check(dependency_root)
    assert result.returncode == 1 and "pyproject" in result.stderr


@pytest.mark.parametrize("replacement", ["core==5.0", "other==4.0"])
def test_dev_lock_cannot_drift_from_runtime_transitives(dependency_root, replacement):
    path = dependency_root / "requirements-dev.txt"
    path.write_text(path.read_text().replace("core==4.0", replacement))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "core" in result.stderr


@pytest.mark.parametrize(
    "replacement",
    [
        "demo==1.0" + HASH,
        "demo[fast]>=1.0" + HASH,
        "demo[fast]==1.0",
        "demo[fast]==1.0 --hash=sha256:bad",
    ],
)
def test_invalid_or_incomplete_runtime_lock_fails(dependency_root, replacement):
    path = dependency_root / "requirements.txt"
    path.write_text(path.read_text().replace("demo[fast]==1.0" + HASH, replacement))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "requirements.txt" in result.stderr


@pytest.mark.parametrize("line", ["other>=2", "-r external.in", "other==2; python_version>'3'"])
def test_new_input_semantics_are_not_silently_ignored(dependency_root, line):
    path = dependency_root / "requirements.in"
    path.write_text(path.read_text() + line + "\n")
    result = run_check(dependency_root)
    assert result.returncode == 1


def test_rejects_an_interpreter_outside_project_python_support(dependency_root):
    path = dependency_root / "pyproject.toml"
    path.write_text(path.read_text().replace(">=3.12", ">=99.0"))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "Python" in result.stderr


def test_missing_lock_is_a_visible_failure(dependency_root):
    (dependency_root / "requirements.txt").unlink()
    result = run_check(dependency_root)
    assert result.returncode == 1 and "requirements.txt" in result.stderr


@pytest.mark.parametrize("file", ["requirements-build.in", "requirements-build.txt"])
def test_build_inputs_metadata_and_lock_cannot_drift(dependency_root, file):
    path = dependency_root / file
    path.write_text(path.read_text().replace("builder==1.0", "builder==2.0"))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "build" in result.stderr


def test_build_lock_cannot_conflict_with_runtime_dependencies(dependency_root):
    path = dependency_root / "requirements-build.txt"
    path.write_text(path.read_text().replace("core==4.0", "core==5.0"))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "core" in result.stderr


def test_dev_lock_cannot_replace_runtime_hashes_at_the_same_version(dependency_root):
    path = dependency_root / "requirements-dev.txt"
    path.write_text(path.read_text().replace("a" * 64, "b" * 64))
    result = run_check(dependency_root)
    assert result.returncode == 1 and "parity" in result.stderr
