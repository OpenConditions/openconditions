# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Shared pytest fixtures.

`SAMPLE_GRAPH` is a small, hand-authored directed road graph used by the
deterministic matching tests. It models a straight east-bound single
carriageway split into two consecutive segments:

    A --(line 10)--> B --(line 11)--> C

plus an unrelated, distant segment so that "no match" cases have a graph to
fail against rather than an empty one.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.maps.memory import InMemoryMap, NodeSpec, LineSpec
from app.frc_fow import Frc, Fow

POSTGIS_REQUIRED = pytest.StashKey[bool]()
POSTGIS_COLLECTED = pytest.StashKey[set[str]]()
POSTGIS_PASSED = pytest.StashKey[set[str]]()
POSTGIS_MODULE = Path(__file__).with_name("test_postgis_reader.py")


def pytest_configure(config):
    mode = os.environ.get("OPENLR_POSTGIS_TESTS", "optional")
    if mode not in ("optional", "required"):
        raise pytest.UsageError(
            f"OPENLR_POSTGIS_TESTS must be 'optional' or 'required'; got {mode!r}"
        )
    config.stash[POSTGIS_REQUIRED] = mode == "required"
    config.stash[POSTGIS_COLLECTED] = set()
    config.stash[POSTGIS_PASSED] = set()


def pytest_itemcollected(item):
    # Observe before -k/--deselect can remove cases from the execution list.
    if item.path == POSTGIS_MODULE:
        item.config.stash[POSTGIS_COLLECTED].add(item.nodeid)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    report = (yield).get_result()
    if item.path == POSTGIS_MODULE and report.when == "call" and report.passed:
        item.config.stash[POSTGIS_PASSED].add(item.nodeid)


def pytest_sessionfinish(session, exitstatus):
    config = session.config
    if not config.stash[POSTGIS_REQUIRED] or exitstatus not in (0, 5):
        return
    collected = config.stash[POSTGIS_COLLECTED]
    missing = collected - config.stash[POSTGIS_PASSED]
    if not collected or missing:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        terminal = config.pluginmanager.get_plugin("terminalreporter")
        if terminal:
            terminal.write_sep("=", "PostGIS coverage incomplete (OPENLR_POSTGIS_TESTS=required)",
                               red=True)
            terminal.write_line("Run every test in tests/test_postgis_reader.py without skips "
                                "or deselection; Docker and the locked dev dependencies are required.")


@pytest.fixture(scope="module")
def postgis_required(request):
    return request.config.stash[POSTGIS_REQUIRED]


# Roughly 270 m apart at this latitude per ~0.0027 degrees of longitude.
NODE_A = (8.0000, 50.0000)
NODE_B = (8.0027, 50.0000)
NODE_C = (8.0054, 50.0000)
# A far-away node pair (different country) for the unresolvable case.
NODE_FAR_1 = (4.9000, 52.3700)
NODE_FAR_2 = (4.9030, 52.3700)


@pytest.fixture
def sample_graph() -> InMemoryMap:
    nodes = {
        0: NodeSpec(0, *NODE_A),
        1: NodeSpec(1, *NODE_B),
        2: NodeSpec(2, *NODE_C),
        3: NodeSpec(3, *NODE_FAR_1),
        4: NodeSpec(4, *NODE_FAR_2),
    }
    lines = {
        10: LineSpec(10, 0, 1, Frc.FRC3, Fow.SINGLE_CARRIAGEWAY),
        11: LineSpec(11, 1, 2, Frc.FRC3, Fow.SINGLE_CARRIAGEWAY),
        20: LineSpec(20, 3, 4, Frc.FRC3, Fow.SINGLE_CARRIAGEWAY),
    }
    return InMemoryMap(nodes, lines)
