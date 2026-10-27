# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the real pytest entry point without contacting an operator database."""

from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
import xml.etree.ElementTree as ET

import pytest

ROOT = Path(__file__).resolve().parents[1]
POSTGIS = "tests/test_postgis_reader.py"


def run_pytest(tmp_path, *, mode="required", block=None, args=None, docker_host=None,
               plugin="", configured_host=None):
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith("TESTCONTAINERS_") or key in (
            "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONTEXT", "TC_HOST", "PYTEST_ADDOPTS",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
        ):
            env.pop(key)
    docker_config = tmp_path / "docker-config"
    docker_config.mkdir()
    (docker_config / "config.json").write_text("{}")
    env.update({
        "DOCKER_HOST": docker_host or f"unix://{tmp_path / 'absent.sock'}",
        "DOCKER_CONFIG": str(docker_config),
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "PYTHONPATH": str(tmp_path),
        "TESTCONTAINERS_RYUK_DISABLED": "true",
        "TC_MAX_TRIES": "1",
        "TC_POOLING_INTERVAL": "0.01",
    })
    if mode is None:
        env.pop("OPENLR_POSTGIS_TESTS", None)
    else:
        env["OPENLR_POSTGIS_TESTS"] = mode
    if block:
        (tmp_path / "sitecustomize.py").write_text(
            "import sys\n"
            "from importlib.abc import MetaPathFinder\n"
            "class Block(MetaPathFinder):\n"
            " def find_spec(self, fullname, path=None, target=None):\n"
            f"  if fullname.split('.')[0] == {block!r}:\n"
            "   raise ModuleNotFoundError('deliberately unavailable dependency: ' + fullname)\n"
            "sys.meta_path.insert(0, Block())\n"
        )
    # Scope configuration discovery to this child; never alter HOME or user files.
    config_dir = tmp_path / "testcontainers-config"
    config_dir.mkdir()
    (config_dir / ".testcontainers.properties").write_text(
        f"tc.host={configured_host}\n" if configured_host else ""
    )
    bootstrap = (
        "import os, runpy, sys\n"
        "from pathlib import Path\n"
        "from unittest.mock import patch\n"
        "try:\n"
        f" with patch.object(Path, 'home', return_value=Path({str(config_dir)!r})):\n"
        "  from testcontainers.core.config import testcontainers_config\n"
        "except ImportError:\n"
        " pass  # Let the real fixture diagnose missing optional/required imports.\n"
        "else:\n"
        " # Pin the private endpoint after discovery, including conflicting tc.host.\n"
        " testcontainers_config.tc_properties = {'tc.host': os.environ['DOCKER_HOST']}\n"
        "sys.argv = ['pytest'] + sys.argv[1:]\n"
        "runpy.run_module('pytest', run_name='__main__')\n"
    )
    command = [sys.executable, "-c", bootstrap, "-q", "-o", f"cache_dir={tmp_path / 'cache'}",
               f"--junitxml={tmp_path / 'results.xml'}"]
    if plugin:
        (tmp_path / "gate_probe.py").write_text(plugin)
        command.extend(["-p", "gate_probe"])
    return subprocess.run(command + (args or [POSTGIS]), cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=40)


@pytest.mark.parametrize("mode", [None, "optional"])
@pytest.mark.parametrize("block", [None, "docker", "testcontainers"])
def test_optional_unavailable_database_skips(tmp_path, mode, block):
    result = run_pytest(tmp_path, mode=mode, block=block)
    assert result.returncode == 0, result.stdout + result.stderr
    cases = ET.parse(tmp_path / "results.xml").findall(".//testcase")
    assert len(cases) == 4
    assert all(case.find("skipped") is not None for case in cases)


@pytest.mark.parametrize("block", [None, "docker", "testcontainers"])
def test_required_unavailable_database_fails(tmp_path, block):
    result = run_pytest(tmp_path, block=block)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "OPENLR_POSTGIS_TESTS=required" in result.stdout + result.stderr


@pytest.mark.parametrize("mode", ["", "Required", "required ", "off"])
def test_invalid_mode_fails_before_optional_import_skip(tmp_path, mode):
    result = run_pytest(tmp_path, mode=mode, block="testcontainers")
    assert result.returncode != 0, result.stdout + result.stderr
    assert "must be 'optional' or 'required'" in result.stdout + result.stderr


def test_required_mode_rejects_omitted_postgis_module(tmp_path):
    result = run_pytest(tmp_path, args=["tests/test_reference.py"])
    assert result.returncode != 0, result.stdout + result.stderr
    assert "PostGIS coverage incomplete" in result.stdout + result.stderr


def test_required_mode_rejects_deselected_postgis_module(tmp_path):
    result = run_pytest(tmp_path, args=[POSTGIS, "-k", "no_such_case"])
    assert result.returncode == 1, result.stdout + result.stderr
    assert "PostGIS coverage incomplete" in result.stdout + result.stderr


@pytest.mark.parametrize("selector, expected", [("::test_first", 1), ("", 0)])
def test_required_inventory_precedes_explicit_node_selection(tmp_path, selector, expected):
    # Run the actual conftest hooks against an independent, parametrized module.
    # Database behavior is covered separately by the real PostGIS suite.
    (tmp_path / "conftest.py").write_bytes((ROOT / "tests/conftest.py").read_bytes())
    module = tmp_path / "test_postgis_reader.py"
    module.write_text("import pytest\ndef test_first(): pass\n"
                      "@pytest.mark.parametrize('value', [1, 2])\n"
                      "def test_rest(value): assert value > 0\n")
    result = run_pytest(tmp_path, args=["-c", str(ROOT / "pyproject.toml"), str(module) + selector])
    assert result.returncode == expected, result.stdout + result.stderr
    assert ("PostGIS coverage incomplete" in result.stdout + result.stderr) == bool(expected)


def test_required_database_import_failure_is_not_a_skip(tmp_path):
    with docker_start_failure() as (host, requests):
        result = run_pytest(tmp_path, block="psycopg_pool", docker_host=host)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "deliberately unavailable dependency: psycopg_pool" in result.stdout + result.stderr
    assert "4 errors" in result.stdout
    assert not any(method == "POST" for method, _ in requests)


def test_required_mode_rejects_deliberate_skips(tmp_path):
    # Deliberate skips must fail even before the fixture's daemon probe runs.
    with docker_start_failure() as (host, requests):
        result = run_pytest(tmp_path, docker_host=host, plugin=(
            "import pytest\n"
            "def pytest_collection_modifyitems(items):\n"
            " for item in items: item.add_marker(pytest.mark.skip(reason='probe'))\n"
        ))
    assert result.returncode != 0, result.stdout + result.stderr
    assert "PostGIS coverage incomplete" in result.stdout + result.stderr
    assert not any(method == "POST" for method, _ in requests)


@contextmanager
def docker_start_failure():
    """Private Docker API: allocate a container, reject start, observe its deletion."""
    requests = []
    container_id = "c" * 64

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, payload):
            requests.append((self.command, self.path))
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/version":
                self.reply(200, {"ApiVersion": "1.45"})
            elif self.path.endswith("/_ping"):
                requests.append((self.command, self.path))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")
            elif "/images/" in self.path:
                self.reply(200, {"Id": "sha256:" + "a" * 64})
            elif "/containers/" in self.path:
                self.reply(200, {"Id": container_id, "Config": {"Image": "postgis"},
                                 "State": {"Running": False}})
            else:
                self.reply(500, {"message": "unexpected fixture request"})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if "/containers/create" in self.path:
                self.reply(201, {"Id": container_id, "Warnings": []})
            else:
                self.reply(500, {"message": "deliberate container startup failure"})

        def do_DELETE(self):
            self.reply(200, {})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"tcp://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


@pytest.mark.parametrize("mode", ["optional", "required"])
def test_container_startup_failure_is_red_and_cleans_up(tmp_path, mode):
    with docker_start_failure() as (host, requests):
        result = run_pytest(tmp_path, mode=mode, docker_host=host)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "deliberate container startup failure" in result.stdout + result.stderr
    assert any(method == "POST" and "/start" in path for method, path in requests), requests
    assert any(method == "DELETE" and "/containers/" in path for method, path in requests), requests


def test_conflicting_testcontainers_host_cannot_redirect_private_endpoint(tmp_path):
    with docker_start_failure() as (private_host, private_requests):
        with docker_start_failure() as (conflicting_host, conflicting_requests):
            result = run_pytest(tmp_path, docker_host=private_host, configured_host=conflicting_host)
    assert result.returncode != 0, result.stdout + result.stderr
    assert not conflicting_requests, conflicting_requests
    assert any(method == "POST" and "/start" in path for method, path in private_requests)
    assert any(method == "DELETE" for method, _ in private_requests)
