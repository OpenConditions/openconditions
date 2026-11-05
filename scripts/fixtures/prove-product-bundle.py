#!/usr/bin/env python3
"""Explicit actual portable proof with owned synthetic native HTTP/artifact authority."""

import argparse
from datetime import timedelta
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "__tests__"))
import test_product_bundle as T  # noqa: E402


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tools", type=Path, required=True)
    p.add_argument("--receipt", type=Path, required=True)
    args = p.parse_args()
    case = T.BundleTests("test_bundle_metadata_and_claim_authority")
    case.setUp()
    records = []
    try:
        B = T.B
        output = case.root / "bundle"
        index = (case.repo / ".git/index").read_bytes()
        result = B.assemble(
            case.api,
            case.repo,
            case.q,
            case.readiness,
            output,
            args.tools,
            tool_source=case.b,
            clock=lambda: T.T.F.NOW,
        )
        assert (
            result["releaseAuthority"] is False
            and result["readinessExecution"] == "BLOCKED_NO_TRUSTED_PRODUCER"
        )
        assert len(result["inventory"]) == 11
        assert (case.repo / ".git/index").read_bytes() == index
        records.append(
            {"case": "actualPortableNativeFixturePositive", "result": result}
        )
        with __import__("unittest").TestCase().assertRaises(ValueError):
            B.assemble(
                case.api,
                case.repo,
                case.q,
                case.readiness,
                output,
                args.tools,
                clock=lambda: T.T.F.NOW,
            )
        real = B.subprocess.run
        for failure in ["expiry", "history"]:
            destination = case.root / failure
            finished = False

            def run(*args, **kwargs):
                nonlocal finished
                r = real(*args, **kwargs)
                if args[0][0] == "node" and "validate-product-manifests.mjs" in str(
                    args[0][1]
                ):
                    assert r.returncode == 0, r.stderr
                    finished = True
                    if failure == "history":
                        case.history_drift = True
                return r

            def clock():
                return T.T.F.NOW + (
                    timedelta(days=4)
                    if finished and failure == "expiry"
                    else timedelta()
                )

            with patch.object(B.subprocess, "run", run):
                try:
                    B.assemble(
                        case.api,
                        case.repo,
                        case.q,
                        case.readiness,
                        destination,
                        args.tools,
                        tool_source=case.b,
                        clock=clock,
                    )
                except ValueError as e:
                    assert finished and ("expired" in str(e) or "history" in str(e)), (
                        str(e)
                    )
                    records.append(
                        {
                            "case": failure,
                            "rejected": str(e),
                            "outputAbsent": not destination.exists(),
                        }
                    )
                else:
                    raise AssertionError("drift accepted")
            assert not destination.exists()
        with args.receipt.open("x") as f:
            json.dump(
                {
                    "scope": "SYNTHETIC_NATIVE_HTTP_AND_LOCAL_ACTUAL_TOOLS_ONLY",
                    "releaseAuthority": False,
                    "cases": records,
                },
                f,
                indent=2,
            )
    finally:
        case.tearDown()


if __name__ == "__main__":
    main()
