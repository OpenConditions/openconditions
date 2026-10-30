#!/usr/bin/env python3
"""Explicit offline contract proof. Requires the exact locally qualified tool bytes.

Not automatically registered as portable acceptance by ordinary CI: those exact local
build artifacts are supplied explicitly. No absent-tool skip or fake validator is supported.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/__tests__"))
import test_product_qualification as T  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    "prepare", ROOT / "scripts/prepare-product-release.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    case = T.ProductTests("test_product_positive")
    case.setUp()
    records = []
    try:
        notes = case.root / "notes.md"
        notes.write_text(
            "Owned offline fixture notes, never a selected real release.\n"
        )
        output = case.root / "prepared"
        before = (case.repo / ".git/index").read_bytes()
        receipt = M.prepare(
            case.api,
            case.repo,
            case.b,
            case.a,
            123,
            2,
            case.version,
            notes,
            output,
            args.tools,
            now=T.F.NOW,
        )
        assert (case.repo / ".git/index").read_bytes() == before
        paths = sorted(
            str(p.relative_to(output)) for p in output.rglob("*") if p.is_file()
        )
        assert len(paths) == 7
        assert (
            receipt["releaseAuthority"] is False
            and receipt["nativeBQualified"] is False
        )
        assert all(
            x["exit"] == 0 for x in receipt["localProof"]["portable"]["portable"]
        )
        records.append(
            {
                "case": "native_transport_fixture_positive",
                "paths": paths,
                "actualToolProof": receipt["localProof"]["portable"],
                "contextInventories": receipt["localProof"]["contextProof"],
                "indexPreserved": True,
                "nativeAuthority": "SIMULATED_OWNED_HTTP_ONLY",
            }
        )
        target = output / "services/ingest/service.json"
        original = target.read_bytes()
        base = json.loads(original)
        for name in [
            "missing-digest",
            "config",
            "secret",
            "network",
            "exposure",
            "identity",
            "substituted-digest",
        ]:
            data = copy.deepcopy(base)
            if name == "missing-digest":
                del data["container"]["digest"]
            if name == "config":
                data["configSchema"]["properties"]["OWNED"] = {
                    "type": "string",
                    "pattern": "a" * 129,
                }
            if name == "secret":
                data["configSchema"]["properties"]["BAD.SECRET"] = {
                    "type": "string",
                    "x-openmapx-secret": True,
                }
            if name == "network":
                data["container"]["networkMode"] = "host"
            if name == "exposure":
                data["container"]["expose"] = [65536]
            if name == "identity":
                data["id"] = "Bad_Service"
            if name == "substituted-digest":
                data["container"]["digest"] = "sha256:" + "f" * 64
            target.write_text(json.dumps(data))
            q = subprocess.run(
                [
                    "node",
                    str(ROOT / "scripts/validate-product-manifests.mjs"),
                    str(output),
                    str(args.tools),
                ],
                capture_output=True,
                text=True,
            )
            # A valid but wrong digest is not knowable by the portable/admission
            # schemas. Native-producer binding is separately tested below.
            if name == "substituted-digest":
                assert q.returncode == 0, q.stderr
            else:
                assert q.returncode != 0 and "contract rejected" in q.stderr, (
                    name,
                    q.stdout,
                    q.stderr,
                )
            records.append(
                {
                    "case": name,
                    "exit": q.returncode,
                    "stdout": q.stdout,
                    "stderr": q.stderr,
                }
            )
            target.write_bytes(original)
        bad_tools = case.root / "changed-tools"
        bad_tools.mkdir()
        (bad_tools / "portable.tgz").write_bytes(
            (args.tools / "portable.tgz").read_bytes() + b"changed"
        )
        (bad_tools / "admission.mjs").write_bytes(
            (args.tools / "admission.mjs").read_bytes()
        )
        q = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/validate-product-manifests.mjs"),
                str(output),
                str(bad_tools),
            ],
            capture_output=True,
            text=True,
        )
        assert q.returncode != 0 and "artifact pin mismatch" in q.stderr, q.stderr
        records.append(
            {
                "case": "tool-artifact-substitution",
                "exit": q.returncode,
                "stderr": q.stderr,
            }
        )
        # Actual extension contract does not enforce OpenConditions membership;
        # the frozen 009A pointer contract does, independent of portable validity.
        extension = output / "extension.json"
        ext_original = extension.read_bytes()
        d = json.loads(ext_original)
        d["services"].append(
            {
                "repo": "https://github.com/OpenConditions/openconditions",
                "ref": "v" + case.version,
                "service": "openconditions-federation",
            }
        )
        extension.write_text(json.dumps(d))
        q = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/validate-product-manifests.mjs"),
                str(output),
                str(args.tools),
            ],
            capture_output=True,
            text=True,
        )
        assert q.returncode == 0, q.stderr
        records.append(
            {
                "case": "optional-membership-portable-only",
                "exit": q.returncode,
                "limit": "Portable validity is not fixed OpenConditions default-membership authority",
            }
        )
        extension.write_bytes(ext_original)
        # Reuse the owned Git fixture to prove frozen-membership and native-image
        # input bindings; this does not create commits in the caller repository.
        for name in ["substituted-digest", "optional-membership"]:
            data = copy.deepcopy(base)
            d = json.loads(ext_original)
            if name == "substituted-digest":
                data["container"]["digest"] = "sha256:" + "f" * 64
            else:
                d["services"].append(d["services"][0])
            for path in paths:
                contents = (output / path).read_bytes()
                if path == "services/ingest/service.json":
                    contents = json.dumps(data).encode()
                if path == "extension.json":
                    contents = json.dumps(d).encode()
                case.put(path, contents)
            b = case.commit()
            inputs = case.root / "binding.json"
            inputs.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "version": case.version,
                        "imageSourceSha": case.a,
                        "producer": {
                            "workflowFile": M.N.WORKFLOW,
                            "runId": 123,
                            "runAttempt": 2,
                        },
                        "images": case.native["images"],
                    }
                )
            )
            q = subprocess.run(
                [
                    "node",
                    str(ROOT / "scripts/check-release-inputs.mjs"),
                    "--image-source",
                    case.a,
                    "--release-source",
                    b,
                    "--version",
                    case.version,
                    "--previous-version",
                    "0.7.0",
                    "--producer-inputs",
                    str(inputs),
                    "--metadata-only",
                ],
                cwd=case.repo,
                capture_output=True,
                text=True,
            )
            assert q.returncode != 0, (name, q.stdout, q.stderr)
            records.append(
                {
                    "case": name + "-producer-pointer-binding",
                    "exit": q.returncode,
                    "stderr": q.stderr,
                }
            )
        args.receipt.write_text(
            json.dumps(
                {
                    "scope": "OFFLINE_SYNTHETIC_HTTP_IMAGES_AND_LOCAL_ACTUAL_CONTRACTS_ONLY",
                    "releaseAuthority": False,
                    "toolArchiveSha256": hashlib.sha256(
                        (args.tools / "portable.tgz").read_bytes()
                    ).hexdigest(),
                    "cases": records,
                },
                indent=2,
            )
            + "\n"
        )
    finally:
        case.tearDown()


if __name__ == "__main__":
    main()
