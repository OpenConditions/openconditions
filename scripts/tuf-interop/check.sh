#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
interop_tmp=$(mktemp -d "${TMPDIR:-/tmp}/oc-tuf-interop.XXXXXX")
trap 'rm -rf "$interop_tmp"' EXIT

# python-tuf and its dependencies, hash-locked, in a disposable environment;
# never installed into the workspace or the resolver's environment.
"${PYTHON:-python3}" -m venv "$interop_tmp/venv"
"$interop_tmp/venv/bin/python" -m pip install --quiet --disable-pip-version-check \
  --require-hashes --only-binary=:all: -r scripts/tuf-interop/requirements.txt
# Repositories and caches go to the disposable directory too.
mkdir "$interop_tmp/work"
TMPDIR="$interop_tmp/work" pnpm exec tsx scripts/tuf-interop/check.ts "$interop_tmp/venv/bin/python"
