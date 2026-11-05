#!/usr/bin/env python3
"""Execute owned default-service recovery; never deployment or release approval."""

from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import tempfile
import time

SPEC = importlib.util.spec_from_file_location(
    "product", Path(__file__).with_name("qualify-product-release.py")
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
N, Q = P.N, P.N.Q


def recover(db, user, database, command=Q.command):
    """pg_dump/pg_restore against a database created ONLY by runtime_smoke."""
    return command(
        [
            "docker",
            "exec",
            db,
            "sh",
            "-ec",
            """
pg_dump -U "$1" -d "$2" --format=custom --schema=conditions --file=/tmp/rehearsal.dump
psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA conditions CASCADE'
test "$(psql -U "$1" -d "$2" -Atqc "SELECT to_regnamespace('conditions') IS NULL")" = t
echo owned-schema-loss-confirmed
pg_restore -U "$1" -d "$2" --exit-on-error /tmp/rehearsal.dump
rm /tmp/rehearsal.dump
""",
            "owned-recovery",
            user,
            database,
        ],
        timeout=180,
    )


def exercise(app, db, sql, record):
    # Synthetic marker is in the same migrated schema as the application data.
    Q.command(
        [
            *sql,
            "CREATE TABLE conditions.release_recovery_probe(value text); "
            "INSERT INTO conditions.release_recovery_probe VALUES ('owned synthetic fixture');",
        ]
    )
    Q.command(["docker", "stop", "--time", "10", app])
    recover(db, "fixture", "fixture")
    N.require(
        Q.command(
            [*sql, "SELECT value FROM conditions.release_recovery_probe"]
        ).stdout.strip()
        == "owned synthetic fixture",
        "backup did not restore fixture bytes",
    )
    Q.command(["docker", "start", app])
    deadline = time.monotonic() + 180
    while True:
        state = Q.decode(Q.command(["docker", "container", "inspect", app]).stdout)[0][
            "State"
        ]
        N.require(state["Running"], "recovered service exited")
        if state.get("Health", {}).get("Status") == "healthy":
            break
        N.require(
            time.monotonic() < deadline, "recovered service health deadline exceeded"
        )
        time.sleep(1)
    record["checks"]["backupRestoreRecovery"] = {
        "outcome": "passed",
        "method": "pg_dump custom / schema loss / pg_restore / service restart / health",
        "data": "synthetic marker in migrated conditions schema; no operator data",
    }


def run(
    api, repo, qualification, output, clock=None, image_directory=None, resume=False
):
    """Only called after native A/B qualification; recheck before/after effects."""
    clock = clock or (lambda: datetime.now(timezone.utc))
    P.validate_receipt(qualification)
    source = qualification["manifestSourceSha"]
    P.final_fences(api, repo, qualification, source, clock, resume=resume)
    N.require(
        N.timestamp(qualification["eligibleUntil"]) > clock(),
        "expired rehearsal evidence",
    )
    output.mkdir()  # Never overwrite a previous run or caller-owned directory.
    result = {
        "schemaVersion": 1,
        "releaseAuthority": False,
        "imageSourceSha": qualification["imageSourceSha"],
        "manifestSourceSha": source,
        "eligibleUntil": qualification["eligibleUntil"],
        "images": qualification["imageEvidence"]["images"],
        "platform": Q.PLATFORM,
        "postgresImage": Q.POSTGIS,
        "startedAt": clock().isoformat(),
        "execution": "failed",
        "limitations": [
            "actual prior-deployment upgrade/migration (no origin supplied)",
            "optional federation/TUF compatibility",
            "other platforms/PostgreSQL cohorts",
            "live providers and operator acceptance",
        ],
        "services": {},
    }
    try:
        native = qualification["imageEvidence"]
        before = P.snapshot_image_artifacts(
            api, native, result["imageSourceSha"], native["producer"]["runId"]
        )
        with tempfile.TemporaryDirectory(prefix="oc-rehearsal-") as temporary:
            work = Path(temporary)
            # B is the checked-out trusted main. Qualification already proved
            # A/B runtime inputs identical; only passive fixture bytes are read.
            checkout = Q.snapshot(repo, source, work)
            for role in ["ingest", "contributions-api"]:
                ref = native["imageArtifacts"][role]
                archive = work / (role + ".zip")
                if image_directory is None:
                    api.download(before[ref["id"]], archive)
                N.require(
                    N.timestamp(qualification["eligibleUntil"]) > clock(),
                    "rehearsal evidence expired during transfer",
                )
                directory = image_directory / role if image_directory else work / role
                if image_directory is None:
                    N.unpack(archive, directory, N.IMAGE_FILES, N.OPTIONAL_FILES)
                verified = Q.verify_reports(
                    directory,
                    role,
                    result["imageSourceSha"],
                    {
                        "kind": "github",
                        "runId": native["producer"]["runId"],
                        "attempt": native["producer"]["runAttempt"],
                    },
                )
                N.require(
                    verified == Q.json_file(directory / "qualified.json")
                    and verified["identity"]["platformManifestDigest"]
                    == native["images"][role]["digest"],
                    "rehearsal artifact substituted",
                )
                # Preserve original runtime evidence; new execution has its own directory.
                runtime = output / (role + "-rehearsal")
                runtime.mkdir()
                (runtime / "image.oci.tar").hardlink_to(directory / "image.oci.tar")
                try:
                    Q.runtime_smoke(
                        role, verified["identity"], checkout, runtime, exercise=exercise
                    )
                finally:
                    (runtime / "image.oci.tar").unlink()
                report = Q.json_file(runtime / "runtime.json")
                N.require(
                    report["passed"]
                    and report["checks"].get("backupRestoreRecovery", {}).get("outcome")
                    == "passed",
                    "partial rehearsal",
                )
                result["services"][role] = {
                    "runtimeSha256": Q.file_sha(runtime / "runtime.json"),
                    "outcome": "passed",
                }
        P.final_fences(api, repo, qualification, source, clock, resume=resume)
        N.require(
            N.timestamp(qualification["eligibleUntil"]) > clock(),
            "rehearsal evidence expired at completion",
        )
        result["execution"] = "passed (bounded default-service install/recovery only)"
        return result
    finally:
        result["completedAt"] = clock().isoformat()
        Q.write_json(output / "rehearsal.json", result)
