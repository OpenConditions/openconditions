# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Regenerate hash locks with the reviewed compiler; never upgrade generally."""

import importlib.metadata
import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    if sys.version_info[:2] != (3, 14):
        raise SystemExit("Regenerate locks with Python 3.14; see README.md.")
    for package, version in [("pip-tools", "7.6.2"), ("pip", "26.2.1")]:
        try:
            actual = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            actual = "missing"
        if actual != version:
            raise SystemExit(f"Regeneration needs {package}=={version}, found {actual}; see README.md.")
    root = Path(__file__).resolve().parents[1]
    env = {key: value for key, value in os.environ.items() if not key.startswith("PIP_")}
    env.update(PIP_CONFIG_FILE=os.devnull, PIP_INDEX_URL="https://pypi.org/simple")
    for stem in ["requirements-build", "requirements", "requirements-dev"]:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "piptools",
                "compile",
                "--generate-hashes",
                "--reuse-hashes",
                "--no-strip-extras",
                "--allow-unsafe",
                "--no-emit-index-url",
                "--no-emit-trusted-host",
                "--output-file",
                f"{stem}.txt",
                f"{stem}.in",
            ],
            cwd=root,
            env=env,
            check=True,
        )
    from scripts.check_dependencies import check

    check(root)


if __name__ == "__main__":
    main()
