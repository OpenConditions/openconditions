#!/usr/bin/env python3
"""Owned review bundle only. No trusted readiness producer or publication authority."""

import argparse
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "product", Path(__file__).with_name("qualify-product-release.py")
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
N, Q = P.N, P.N.Q
require = N.require
STEPS = (
    "cleanInstall",
    "configurationHealth",
    "representativeFixturesRightsPrivacy",
    "upgradeMigration",
    "backupRestoreRecovery",
    "federationTufCompatibility",
)


def keys(value, names):
    require(
        type(value) is dict and set(value) == set(names.split()),
        "missing/unknown bundle claim fields",
    )


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)


def readiness_claim(value, qualification, now):
    """Content validation, never an assertion that these operations occurred."""
    if value is None:
        require(
            N.timestamp(qualification["eligibleUntil"]) > now, "expired bundle evidence"
        )
        return  # Missing execution evidence blocks publication, not review artifacts.
    keys(
        value,
        "schemaVersion imageSourceSha manifestSourceSha images platform postgresMajor priorDeployment steps",
    )
    require(
        type(value["schemaVersion"]) is int and value["schemaVersion"] == 1,
        "unsupported readiness schema",
    )
    for key in ["imageSourceSha", "manifestSourceSha"]:
        require(value[key] == qualification[key], "readiness candidate mismatch")
    images = qualification["imageEvidence"]["images"]
    require(
        value["images"] == {k: v["digest"] for k, v in images.items()},
        "readiness digest mismatch",
    )
    require(
        all(value["platform"] in v["platforms"] for v in images.values()),
        "readiness platform mismatch",
    )
    # These are existing test cohorts, not a new production support declaration.
    require(
        type(value["postgresMajor"]) is int and value["postgresMajor"] in [16, 18],
        "unqualified PostgreSQL cohort",
    )
    prior = value["priorDeployment"]
    keys(prior, "identity sourceSha imageDigest schemaSha256")
    require(
        isinstance(prior["identity"], str)
        and prior["identity"].strip()
        and isinstance(prior["sourceSha"], str)
        and re.fullmatch(r"[a-f0-9]{40}", prior["sourceSha"])
        and isinstance(prior["imageDigest"], str)
        and Q.DIGEST.fullmatch(prior["imageDigest"])
        and digest(prior["schemaSha256"]),
        "missing actual prior deployment identity claim",
    )
    keys(value["steps"], " ".join(STEPS))
    for step in value["steps"].values():
        keys(step, "outcome startedAt completedAt tool evidenceSha256")
        require(
            step["outcome"] == "passed" and digest(step["evidenceSha256"]),
            "missing/failed readiness step",
        )
        require(
            N.timestamp(step["startedAt"]) <= N.timestamp(step["completedAt"]) <= now,
            "invalid readiness execution times",
        )
        keys(step["tool"], "name version sha256")
        require(
            all(
                isinstance(step["tool"][k], str) and step["tool"][k].strip()
                for k in ["name", "version"]
            )
            and digest(step["tool"]["sha256"]),
            "missing readiness tool binding",
        )
    require(
        N.timestamp(qualification["eligibleUntil"]) > now, "expired bundle evidence"
    )


def safe_path(path):
    require(
        isinstance(path, str)
        and path
        and not PurePosixPath(path).is_absolute()
        and all(p not in ["", ".", ".."] for p in path.split("/"))
        and "\\" not in path,
        "unsafe bundle path",
    )


def bundle_files(repo, qualification, readiness, now):
    P.validate_receipt(qualification)
    readiness_claim(readiness, qualification, now)
    files = {}
    for path, expected in qualification["manifestSha256"].items():
        safe_path(path)
        mode = (
            P.git(repo, "ls-tree", qualification["manifestSourceSha"], "--", path)
            .decode()
            .split()[0]
        )
        require(mode == "100644", "metadata must be regular mode0644")
        data = P.git(repo, "show", f"{qualification['manifestSourceSha']}:{path}")
        require(Q.sha(data) == expected, "metadata hash mismatch")
        files[path] = data
    version = qualification["version"]
    expected = {
        "extension.json",
        *[
            f"services/{s}/service.json"
            for s in ["ingest", "ingest-heavy", "contributions-api", "federation"]
        ],
        f"docs/release-notes/{version}.json",
        f"docs/release-notes/{version}.md",
    }
    require(set(files) == expected, "incomplete metadata set")
    files["qualification.json"] = N.canonical(qualification)
    files["readiness-claim.json"] = N.canonical(readiness)
    files["artifact-references.json"] = N.canonical(qualification["imageEvidence"])
    manifest = {
        "schemaVersion": 1,
        "kind": "Owned release review bundle only",
        "imageSourceSha": qualification["imageSourceSha"],
        "manifestSourceSha": qualification["manifestSourceSha"],
        "tagTargetSha": qualification["tagTargetSha"],
        "eligibleUntil": qualification["eligibleUntil"],
        "releaseAuthority": False,
        "nativeQualification": "NOT_ESTABLISHED_BY_LOCAL_BUNDLE",
        "readinessContent": "PENDING" if readiness is None else "VALIDATED_CLAIMS_ONLY",
        "readinessExecution": "BLOCKED_NO_TRUSTED_PRODUCER",
        "imageBytes": "REFERENCED_NOT_REPACKED",
        "downstream": qualification["downstream"],
        "inventory": {
            p: {"sha256": Q.sha(data), "mode": 0o644}
            for p, data in sorted(files.items())
        },
    }
    files["bundle.json"] = N.canonical(manifest)
    validate_inventory(files)
    return files


def validate_inventory(files):
    manifest = Q.decode(files["bundle.json"])
    keys(
        manifest,
        "schemaVersion kind imageSourceSha manifestSourceSha tagTargetSha eligibleUntil releaseAuthority nativeQualification readinessContent readinessExecution imageBytes downstream inventory",
    )
    qualification = Q.decode(files["qualification.json"])
    P.validate_receipt(qualification)
    require(
        all(
            manifest[key] == qualification[key]
            for key in [
                "imageSourceSha",
                "manifestSourceSha",
                "tagTargetSha",
                "eligibleUntil",
                "downstream",
            ]
        ),
        "bundle source/provenance mismatch",
    )
    expected = {
        "bundle.json",
        "qualification.json",
        "artifact-references.json",
        "readiness-claim.json",
        *qualification["manifestSha256"],
    }
    if "portable.json" in files:
        expected.add("portable.json")
    require(set(files) == expected, "unsupported bundle set")
    require(
        Q.decode(files["artifact-references.json"]) == qualification["imageEvidence"],
        "artifact reference substitution",
    )
    require(
        all(Q.sha(files[p]) == h for p, h in qualification["manifestSha256"].items()),
        "metadata substitution",
    )
    require(
        set(files) == {"bundle.json", *manifest["inventory"]},
        "incomplete/unexpected bundle inventory",
    )
    for path, identity in manifest["inventory"].items():
        safe_path(path)
        require(
            identity == {"sha256": Q.sha(files[path]), "mode": 0o644},
            "bundle inventory mismatch",
        )
    require(
        manifest["releaseAuthority"] is False
        and manifest["readinessExecution"] == "BLOCKED_NO_TRUSTED_PRODUCER"
        and manifest["nativeQualification"] == "NOT_ESTABLISHED_BY_LOCAL_BUNDLE",
        "unsupported bundle authority",
    )


def verify_directory(output, files):
    actual = {}
    parents = {
        str(parent)
        for path in files
        for parent in PurePosixPath(path).parents
        if str(parent) != "."
    }
    require(not output.is_symlink(), "bundle root symlink")
    for directory, dirs, names in os.walk(output, followlinks=False):
        for name in dirs:
            require(
                str((Path(directory) / name).relative_to(output)) in parents,
                "unexpected bundle directory",
            )
            require(
                not (Path(directory) / name).is_symlink(), "bundle directory symlink"
            )
        for name in names:
            p = Path(directory) / name
            require(stat.S_IMODE(p.lstat().st_mode) == 0o644, "bundle mode mismatch")
            actual[str(p.relative_to(output))] = Q.regular(p)
    require(actual == files, "bundle bytes/set mismatch")


def emit(output, files):
    for path in files:
        safe_path(path)
    # No overwrite or destructive cleanup; partial IO failures remain inspectable.
    output.mkdir()
    for path, data in files.items():
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
        target.chmod(0o644)
    verify_directory(output, files)


def final_native_fences(api, repo, qualification, tool_source, clock):
    n = qualification["imageEvidence"]
    a = n["producer"]
    b = qualification["manifestEvidence"]
    require(
        P.latest_manifest(
            api,
            qualification["manifestSourceSha"],
            b["producer"]["runId"],
            b["producer"]["runAttempt"],
            clock,
        )
        == b,
        "B changed before bundle output",
    )
    require(
        N.inspect_run(
            api,
            qualification["imageSourceSha"],
            a["runId"],
            a["runAttempt"],
            clock(),
            True,
        )[0]
        == a,
        "A changed before bundle output",
    )
    P.snapshot_image_artifacts(api, n, qualification["imageSourceSha"], a["runId"])
    require(
        api.json(N.PREFIX + "/git/ref/heads/main").get("object", {}).get("sha")
        == tool_source
        and Q.sha(N.canonical(P.history(api))) == qualification["historySha256"],
        "main/history changed before bundle output",
    )
    P.policy(repo, tool_source, qualification["imageSourceSha"])


def assemble(
    api,
    repo,
    qualification,
    readiness,
    output,
    tools,
    *,
    tool_source=None,
    clock=None,
    before_emit=None,
):
    clock = clock or (lambda: datetime.now(timezone.utc))
    require(
        not output.exists()
        and not output.is_symlink()
        and repo.resolve() not in output.resolve().parents
        and repo.resolve() != output.resolve(),
        "output must be new outside caller checkout",
    )
    native = tool_source is not None
    if native:
        qualification = P.qualify(
            api,
            repo,
            tool_source,
            qualification["imageSourceSha"],
            qualification["manifestSourceSha"],
            qualification["imageEvidence"]["producer"]["runId"],
            qualification["imageEvidence"]["producer"]["runAttempt"],
            qualification["manifestEvidence"]["producer"]["runId"],
            qualification["manifestEvidence"]["producer"]["runAttempt"],
            qualification["version"],
            clock=clock,
        )
    files = bundle_files(repo, qualification, readiness, clock())
    with tempfile.TemporaryDirectory(prefix="oc-bundle-contracts-") as temporary:
        work = Path(temporary)
        for path in qualification["manifestSha256"]:
            target = work / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(files[path])
        result = subprocess.run(
            [
                "node",
                str(P.TOOLS / "scripts/validate-product-manifests.mjs"),
                str(work),
                str(tools),
            ],
            capture_output=True,
            timeout=900,
        )
        require(
            result.returncode == 0,
            "actual portable/admission validation failed: "
            + result.stderr.decode(errors="replace")[-8000:],
        )
        portable = Q.decode(result.stdout)
    files["portable.json"] = N.canonical(portable)
    manifest = Q.decode(files["bundle.json"])
    manifest["inventory"]["portable.json"] = {
        "sha256": Q.sha(files["portable.json"]),
        "mode": 0o644,
    }
    files["bundle.json"] = N.canonical(manifest)
    # Final native fences: no repeated image transfer or locally claimed authority.
    readiness_claim(readiness, qualification, clock())
    if native:
        final_native_fences(api, repo, qualification, tool_source, clock)
    if before_emit is not None:
        before_emit()
    readiness_claim(readiness, qualification, clock())
    validate_inventory(files)
    emit(output, files)
    return Q.decode(files["bundle.json"])


def main():
    native = "--native" in sys.argv[1:]
    source = P.context(os.environ) if native else None
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", action="store_true")
    for name in ["qualification", "readiness", "output", "tools"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    result = assemble(
        N.Github(os.environ.get("GH_TOKEN", "")) if native else None,
        Path.cwd(),
        Q.json_file(args.qualification),
        Q.json_file(args.readiness),
        args.output,
        args.tools,
        tool_source=source,
    )
    print(N.canonical(result).decode())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            str(error) if isinstance(error, ValueError) else "Owned bundle failed",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
