# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Offline parity of authoritative direct pins, project metadata and hash locks."""

import sys

if sys.version_info < (3, 12):
    print("Dependency parity requires Python 3.12 or newer.", file=sys.stderr)
    raise SystemExit(1)

import argparse
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Pin:
    version: str
    extras: frozenset[str]
    hashes: frozenset[str] = frozenset()


def exact_pin(text: str, source: str) -> tuple[str, Pin]:
    match = re.fullmatch(
        r"([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([A-Za-z0-9,._-]+)\])?==([0-9][A-Za-z0-9.!+_-]*)", text
    )
    if not match:
        raise ValueError(f"{source}: unsupported requirement {text!r}; use exact pins")
    name, extras, version = match.groups()

    def normalize(value):
        return re.sub(r"[-_.]+", "-", value).lower()

    return normalize(name), Pin(version, frozenset(normalize(e) for e in (extras or "").split(",") if e))


def records(path: Path) -> list[str]:
    result, pending = [], ""
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        pending += " " + line.removesuffix("\\").strip()
        if not line.endswith("\\"):
            result.append(pending.strip())
            pending = ""
    if pending:
        raise ValueError(f"{path.name}: unfinished continuation")
    return result


def pins(lines: list[str], source: str, hashed: bool = False) -> dict[str, Pin]:
    result = {}
    for line in lines:
        fields = line.split()
        name, pin = exact_pin(fields[0], source)
        if hashed:
            if len(fields) < 2 or any(
                not re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", h) for h in fields[1:]
            ):
                raise ValueError(f"{source}: {name} needs complete SHA256 hashes")
        elif len(fields) != 1:
            raise ValueError(f"{source}: unsupported requirement {line!r}")
        if name in result:
            raise ValueError(f"{source}: duplicate pin for {name}")
        result[name] = Pin(pin.version, pin.extras, frozenset(fields[1:]) if hashed else frozenset())
    return result


def check(root: Path) -> None:
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    minimum = re.fullmatch(r">=(\d+)\.(\d+)", project["requires-python"])
    if not minimum:
        raise ValueError("pyproject: unsupported requires-python expression")
    if sys.version_info[:2] < tuple(map(int, minimum.groups())):
        raise ValueError(f"Python {project['requires-python']} required by pyproject")
    runtime = pins(records(root / "requirements.in"), "requirements.in")
    development = records(root / "requirements-dev.in")
    if development.count("-r requirements.txt") != 1:
        raise ValueError("requirements-dev.in must include -r requirements.txt exactly once")
    development.remove("-r requirements.txt")
    dev = pins(development, "requirements-dev.in")
    build = pins(records(root / "requirements-build.in"), "requirements-build.in")
    if runtime.keys() & dev.keys():
        raise ValueError("requirements-dev.in duplicates runtime inputs")
    if runtime != pins(project["dependencies"], "pyproject.dependencies"):
        raise ValueError("pyproject.dependencies conflict with requirements.in")
    if dev != pins(project["optional-dependencies"]["dev"], "pyproject.dev"):
        raise ValueError("pyproject.dev conflicts with requirements-dev.in")
    if build != pins(project["optional-dependencies"]["build"], "pyproject.build"):
        raise ValueError("pyproject.build conflicts with requirements-build.in")
    runtime_lock = pins(records(root / "requirements.txt"), "requirements.txt", hashed=True)
    dev_lock = pins(records(root / "requirements-dev.txt"), "requirements-dev.txt", hashed=True)
    build_lock = pins(records(root / "requirements-build.txt"), "requirements-build.txt", hashed=True)
    for source, expected, lock in [
        ("requirements.txt", runtime, runtime_lock),
        ("requirements-dev.txt", dev, dev_lock),
        ("requirements-build.txt", build, build_lock),
        ("requirements-dev.txt (runtime parity)", runtime_lock, dev_lock),
    ]:
        for name, pin in expected.items():
            actual = lock.get(name)
            if (
                actual is None
                or actual.version != pin.version
                or not pin.extras <= actual.extras
                or not pin.hashes <= actual.hashes
            ):
                raise ValueError(
                    f"{source}: stale or missing {name}=={pin.version} with extras {sorted(pin.extras)}"
                )
    for name in build_lock.keys() & dev_lock.keys():
        if (
            build_lock[name].version != dev_lock[name].version
            or not build_lock[name].hashes <= dev_lock[name].hashes
        ):
            raise ValueError(f"requirements-build.txt: {name} conflicts with runtime/dev lock")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        check(args.root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Dependency parity failed: {error}", file=sys.stderr)
        return 1
    print("Python dependency inputs, project metadata and hash locks agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
