#!/usr/bin/env python3
"""Explicit actual tools + owned HTTP/Git CI orchestration proof, never live authority."""

import argparse
import copy
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "__tests__"))
import test_product_flow as T  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    case = T.FlowTests("test_flow_pending_not_approval")
    case.setUp()
    try:
        before = (case.repo / ".git/index").read_bytes()
        review = case.root / "review"
        result = T.M.execute(
            case.api,
            case.repo,
            case.b,
            "review",
            case.version,
            "",
            args.tools,
            review,
            clock=lambda: T.T.F.NOW,
        )
        assert (
            result["releaseAuthority"] is False
            and result["readinessContent"] == "PENDING"
        )
        original_b = case.b
        original_brun = copy.deepcopy(case.brun)
        case.b = case.a
        case.brun = copy.deepcopy(case.run)
        prepared = case.root / "prepared"
        proof = T.M.execute(
            case.api,
            case.repo,
            case.a,
            "prepare",
            case.version,
            "Owned reviewed notes.",
            args.tools,
            prepared,
            clock=lambda: T.T.F.NOW,
        )
        files = sorted(
            str(p.relative_to(prepared)) for p in prepared.rglob("*") if p.is_file()
        )
        assert len(files) == 7 and proof["releaseAuthority"] is False
        assert (case.repo / ".git/index").read_bytes() == before
        with args.receipt.open("x") as f:
            json.dump(
                {
                    "scope": "ACTUAL_PINNED_TOOLS_SYNTHETIC_NATIVE_AUTHORITY_ONLY",
                    "releaseAuthority": False,
                    "review": result,
                    "preparedPaths": files,
                    "indexPreserved": True,
                },
                f,
                indent=2,
            )
        case.b = original_b
        case.brun = original_brun
    finally:
        case.tearDown()


if __name__ == "__main__":
    main()
