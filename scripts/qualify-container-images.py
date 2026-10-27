#!/usr/bin/env python3
"""Nonpublishing, single-platform PR image qualification. Never release authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path

PLATFORM = "linux/amd64"
IMAGES = {
    "ingest": (".", 4100),
    "contributions-api": (".", 4200),
    "federation": (".", 4300),
    "openlr-resolver": ("services/openlr-resolver", 4200),
}
TRIVY = "aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
POSTGIS = (
    "postgis/postgis:16-3.4@sha256:"
    "44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5"
)
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def fail(message):
    raise ValueError(message)


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            fail("duplicate JSON key")
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=pairs)


def regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            fail("expected regular artifact file")
        data = stream.read()
        after = os.fstat(stream.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            fail("artifact changed during read")
        return data


def json_file(path):
    return decode(regular(path))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            fail("expected regular artifact file")
        result = hashlib.file_digest(stream, "sha256").hexdigest()
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            fail("artifact changed during hashing")
        return result


def write_json(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def command(args, *, cwd=None, log=None, check=True, timeout=120):
    if args[0] == "git":
        args = ["git", "--no-replace-objects", *args[1:]]
    result = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=log or subprocess.PIPE,
        stderr=subprocess.STDOUT if log else subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode:
        # Do not echo environment values or arbitrary container output here.
        fail(
            f"{args[0]} {args[1]} failed (exit {result.returncode}); inspect retained logs"
        )
    return result


def inspect_archive(archive, layout=None):
    """Validate the complete OCI blob graph without extracting any layer files."""
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            fail("expected regular archive")
        return inspect_stream(stream, layout)


def inspect_stream(stream, layout):
    before = os.fstat(stream.fileno())
    archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    stream.seek(0)
    if layout:
        layout.mkdir()
    with tarfile.open(fileobj=stream, mode="r:") as tar:
        names = set()
        documents = {}
        blobs = {}
        for member in tar:
            name = member.name
            if name in names:
                fail("duplicate archive member")
            names.add(name)
            allowed = name in (
                "blobs",
                "blobs/",
                "blobs/sha256",
                "blobs/sha256/",
                "index.json",
                "oci-layout",
            )
            if not allowed and not re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name):
                fail("unexpected or unsafe archive member")
            if member.isdir():
                if name not in ("blobs", "blobs/", "blobs/sha256", "blobs/sha256/"):
                    fail("unexpected archive directory")
                continue
            if not member.isfile():
                fail("archive links/devices are forbidden")
            digest = hashlib.sha256()
            size = 0
            # JSON documents are small; layer contents are streamed, never unpacked.
            data = bytearray()
            sink = None
            if layout:
                path = layout / name
                path.parent.mkdir(parents=True, exist_ok=True)
                sink = path.open("xb")
            try:
                with tar.extractfile(member) as contents:
                    while block := contents.read(1024 * 1024):
                        digest.update(block)
                        size += len(block)
                        if size <= 4 * 1024 * 1024:
                            data.extend(block)
                        else:
                            data.clear()
                        if sink:
                            sink.write(block)
            finally:
                if sink:
                    sink.close()
            if size != member.size:
                fail("incomplete archive member")
            if name.startswith("blobs/"):
                if name != f"blobs/sha256/{digest.hexdigest()}":
                    fail("OCI blob digest mismatch")
                blobs[f"sha256:{digest.hexdigest()}"] = (size, bytes(data))
            else:
                documents[name] = bytes(data)
        if decode(documents.get("oci-layout", b"null")) != {
            "imageLayoutVersion": "1.0.0"
        }:
            fail("invalid OCI layout")
        index = decode(documents.get("index.json", b"null"))
        if (
            not isinstance(index, dict)
            or index.get("schemaVersion") != 2
            or len(index.get("manifests", [])) != 1
        ):
            fail("expected exactly one platform manifest")

        def blob(descriptor, *, document=False):
            if not isinstance(descriptor, dict) or not DIGEST.fullmatch(
                descriptor.get("digest", "")
            ):
                fail("invalid OCI descriptor digest")
            found = blobs.get(descriptor["digest"])
            if (
                not found
                or type(descriptor.get("size")) is not int
                or found[0] != descriptor["size"]
            ):
                fail("missing or incorrectly sized OCI blob")
            if document and not found[1]:
                fail("oversized OCI JSON document")
            return decode(found[1]) if document else None

        ref = index["manifests"][0]
        manifest = blob(ref, document=True)
        if (
            ref.get("mediaType") != "application/vnd.oci.image.manifest.v1+json"
            or manifest.get("schemaVersion") != 2
        ):
            fail("invalid platform manifest")
        config = blob(manifest["config"], document=True)
        if config.get("os") + "/" + config.get("architecture") != PLATFORM:
            fail("unqualified image platform")
        if ref.get("platform") and ref["platform"] != {
            "os": "linux",
            "architecture": "amd64",
        }:
            fail("inconsistent descriptor platform")
        layers = manifest.get("layers")
        if (
            not isinstance(layers, list)
            or not layers
            or len(config.get("rootfs", {}).get("diff_ids", [])) != len(layers)
        ):
            fail("missing image layers")
        for layer in layers:
            blob(layer)
        stream.seek(0)
        after_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        after = os.fstat(stream.fileno())
        if archive_hash != after_hash or (
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            fail("archive changed during validation")
        if set(blobs) != {
            ref["digest"],
            manifest["config"]["digest"],
            *(v["digest"] for v in layers),
        }:
            fail("unreferenced OCI blob")
        return {
            "archiveContentSha256": archive_hash,
            "ociIndexContentSha256": sha(documents["index.json"]),
            "platformManifestDigest": ref["digest"],
            "configDigest": manifest["config"]["digest"],
            "platform": PLATFORM,
            "registryAuthority": False,
            "diffIds": config["rootfs"]["diff_ids"],
            "title": config.get("config", {})
            .get("Labels", {})
            .get("org.opencontainers.image.title"),
        }


def execution():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return {"kind": "local", "runId": None, "attempt": None}
    values = [
        os.environ.get(name, "") for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")
    ]
    if not all(re.fullmatch(r"[1-9][0-9]*", value) for value in values):
        fail("invalid workflow run/attempt")
    return {"kind": "github", "runId": int(values[0]), "attempt": int(values[1])}


def verify_reports(directory, image, source, expected_execution):
    identity = inspect_archive(directory / "image.oci.tar")
    if json_file(directory / "identity.json") != identity:
        fail("image identity mismatch")
    names = (
        "scan.json",
        "sbom.cdx.json",
        "runtime.json",
        "build-metadata.json",
        "scanner-db.json",
    )
    raw = {name: regular(directory / name) for name in names}
    data = {name: decode(value) for name, value in raw.items()}
    metadata = data["build-metadata.json"]
    if (
        metadata.get("containerimage.config.digest") != identity["configDigest"]
        or metadata.get("containerimage.digest") != identity["platformManifestDigest"]
        or not metadata.get("buildx.build.ref")
    ):
        fail("build metadata image identity mismatch")
    title = (
        "OpenConditions OpenLR resolver"
        if image == "openlr-resolver"
        else f"OpenConditions {image}"
    )
    if identity.get("title") != title:
        fail("image role/recipe identity mismatch")
    scan = data["scan.json"]
    if (
        scan.get("SchemaVersion") != 2
        or scan.get("Metadata", {}).get("ImageID") != identity["configDigest"]
    ):
        fail("scanner image/config identity mismatch")
    results = scan.get("Results")
    language = "python-pkg" if image == "openlr-resolver" else "node-pkg"
    if not isinstance(results, list) or not {"alpine", language}.issubset(
        {r.get("Type") for r in results}
    ):
        fail("missing OS or language scan coverage")
    for result in results:
        if result.get("Type") in ("alpine", language) and not result.get("Packages"):
            fail("missing package inventory in scanner coverage")
        vulns = result.get("Vulnerabilities", [])
        if vulns is None:
            vulns = []
        if not isinstance(vulns, list) or vulns:
            fail("image vulnerability finding or malformed scanner result")
    db = data["scanner-db.json"]
    stamps = [
        datetime.fromisoformat(value)
        for value in (db["UpdatedAt"], scan["CreatedAt"], db["NextUpdate"])
    ]
    if (
        db.get("Version") != 2
        or any(stamp.utcoffset() is None for stamp in stamps)
        or not stamps[0] <= stamps[1] <= stamps[2]
    ):
        fail("scanner DB was not current at scan time")
    sbom = data["sbom.cdx.json"]
    properties = sbom.get("metadata", {}).get("component", {}).get("properties", [])
    ids = [
        p.get("value")
        for p in properties
        if p.get("name") == "aquasecurity:trivy:ImageID"
    ]
    tools = sbom.get("metadata", {}).get("tools", {}).get("components", [])
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or ids != [identity["configDigest"]]
        or not sbom.get("components")
    ):
        fail("missing/incorrect SBOM image binding")
    if not any(
        t.get("name") == "trivy" and t.get("version") == "0.76.1" for t in tools
    ):
        fail("unqualified SBOM scanner version")
    runtime = data["runtime.json"]
    if (
        runtime.get("passed") is not True
        or runtime.get("health") != "healthy"
        or runtime.get("identity") != identity
    ):
        fail("runtime image/health qualification missing")
    if len(runtime.get("cleanup", [])) != 3 or not all(
        r.get("absent") is True and r.get("removalExit") == 0
        for r in runtime["cleanup"]
    ):
        fail("runtime resources not cleaned")
    if not re.fullmatch(r"16[0-9]{4}\|3\.[0-9.]+", runtime.get("physicalPostGIS", "")):
        fail("missing physical PG16 evidence")
    expected_checks = (
        {"openlrGraphHttpNative"}
        if image == "openlr-resolver"
        else {"httpNativeCrypto", "migratedTables"}
    )
    if image == "ingest":
        expected_checks |= {
            "osmiumVersion",
            "osmiumFileInfo",
            "bundledFeedsMigrationsImpit",
        }
    if set(runtime.get("checks", {})) != expected_checks:
        fail("missing required runtime/native checks")
    cleaned = runtime["cleanup"]
    if len({r.get("name") for r in cleaned}) != 3 or sorted(
        r.get("kind") for r in cleaned
    ) != ["container", "container", "network"]:
        fail("duplicate/missing runtime resource cleanup")
    possible = {
        identity["configDigest"],
        identity["platformManifestDigest"],
        "sha256:" + identity["ociIndexContentSha256"],
    }
    if runtime.get("dockerRuntimeImageId") not in possible:
        fail("runtime image identity is not bound")
    checks = runtime["checks"]
    if image == "openlr-resolver":
        native = checks["openlrGraphHttpNative"]
        if (
            native.get("graphCounts") != [5, 5]
            or native.get("invalidReferenceStatus") != 400
            or native.get("match", {}).get("confidence", 0) <= 0.5
        ):
            fail("OpenLR native/HTTP graph qualification missing")
    else:
        status = checks["httpNativeCrypto"]
        service = (
            "openconditions-federation-api"
            if image == "federation"
            else "openconditions-" + image
        )
        if (
            status.get("status") != "ok"
            or status.get("service") != service
            or type(checks["migratedTables"]) is not int
            or checks["migratedTables"] < 10
        ):
            fail("runtime HTTP/migrations qualification missing")
        if image == "ingest" and (
            checks["bundledFeedsMigrationsImpit"] is not True
            or not checks["osmiumVersion"].startswith("osmium version 1.19.1")
            or checks["osmiumFileInfo"].get("data", {}).get("count", {}).get("nodes", 0)
            < 5
        ):
            fail("ingest native/bundled input qualification missing")
    loaded = runtime.get("loadedImageCleanup", {})
    if type(loaded.get("owned")) is not bool or (
        loaded.get("owned")
        and (loaded.get("absent") is not True or loaded.get("removalExit") != 0)
    ):
        fail("loaded image cleanup not confirmed")
    return {
        "schemaVersion": 1,
        "image": image,
        "sourceSha": source,
        "execution": expected_execution,
        "identity": identity,
        "artifacts": {name: sha(value) for name, value in raw.items()},
        "scannerImage": TRIVY,
        "releaseAuthority": False,
    }


def collect(directory, source):
    if os.environ.get("IMAGE_BUILD_RESULT") != "success":
        fail("image matrix did not succeed")
    current = execution()
    if current["kind"] != "github":
        fail("matrix collection requires workflow run/attempt")
    names = {f"image-{image}-{current['attempt']}" for image in IMAGES}
    if not directory.is_dir() or {p.name for p in directory.iterdir()} != names:
        fail("missing or unexpected matrix artifacts")
    for image in IMAGES:
        path = directory / f"image-{image}-{current['attempt']}"
        if path.is_symlink() or not path.is_dir():
            fail("unsafe artifact directory")
        expected = verify_reports(path, image, source, current)
        if json_file(path / "qualified.json") != expected:
            fail("stale/mismatched qualification receipt")
    return {
        "images": list(IMAGES),
        "sourceSha": source,
        "execution": current,
        "releaseAuthority": False,
    }


def snapshot(repo, source, work):
    if command(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip() != source:
        fail("checkout does not match requested immutable source")
    tree = {}
    for line in command(["git", "ls-tree", "-rz", source], cwd=repo).stdout.split("\0"):
        if not line:
            continue
        match = re.fullmatch(r"(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)", line)
        if not match:
            fail("source requires regular Git files, no links/submodules")
        mode, oid, name = match.groups()
        if (
            name.startswith("/")
            or "\\" in name
            or any(p in ("", ".", "..") for p in name.split("/"))
        ):
            fail("unsafe source archive path")
        tree[name] = (mode, oid)
    archive = work / "source.tar"
    command(
        [
            "git",
            "-c",
            "core.attributesFile=/dev/null",
            "archive",
            "--format=tar",
            f"--output={archive}",
            source,
        ],
        cwd=repo,
    )
    destination = work / "source"
    destination.mkdir()
    seen = set()
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            if member.isdir():
                continue
            if not member.isfile() or member.name not in tree or member.name in seen:
                fail("unexpected source archive member")
            seen.add(member.name)
            data = tar.extractfile(member).read()
            mode, oid = tree[member.name]
            if hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() != oid:
                fail("source archive changed Git object bytes")
            path = destination / member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(data)
            path.chmod(0o755 if mode == "100755" else 0o644)
    if seen != set(tree):
        fail("source archive omitted tracked files")
    return destination


def absent(result, kind, name):
    # A broken daemon/permission error is uncertainty, not confirmed cleanup.
    text = result.stderr or ""
    return result.returncode != 0 and bool(
        re.search(
            rf"No such (?:container|object|image|network):?\s*{re.escape(name)}"
            rf"|network {re.escape(name)} not found",
            text,
            re.IGNORECASE,
        )
    )


def remove_owned(kind, name, label):
    found = command(["docker", kind, "inspect", name], check=False)
    if absent(found, kind, name):
        return {"kind": kind, "name": name, "removalExit": 0, "absent": True}
    if found.returncode:
        return {"kind": kind, "name": name, "removalExit": None, "absent": False}
    obj = decode(found.stdout)[0]
    labels = (
        obj.get("Config", {}).get("Labels", {})
        if kind == "container"
        else obj.get("Labels", {})
    )
    if labels.get("openconditions.qualification") != label:
        return {"kind": kind, "name": name, "removalExit": None, "absent": False}
    args = ["docker", kind, "rm", *(["-f", "-v"] if kind == "container" else []), name]
    removed = command(args, check=False)
    missing = command(["docker", kind, "inspect", name], check=False)
    return {
        "kind": kind,
        "name": name,
        "removalExit": removed.returncode,
        "absent": absent(missing, kind, name),
    }


OPENLR_SMOKE = """import math,json,urllib.request,urllib.error,os
import osmium,shapely,psycopg
from scripts.build_graph import build_graph,load_into_postgis
from openlr import Coordinates,FRC,FOW,LocationReferencePoint,LineLocationReference,binary_encode
from openlr_dereferencer.maps.wgs84 import bearing,distance
graph=build_graph('/fixture.osm');counts=load_into_postgis(graph,os.environ['DATABASE_URL'])
assert counts==(5,5),counts
a=(8.,50.);b=(8.0027,50.);c=(8.0054,50.)
d=distance(Coordinates(*a),Coordinates(*b))+distance(Coordinates(*b),Coordinates(*c))
f=LocationReferencePoint(*a,FRC.FRC3,FOW.SINGLE_CARRIAGEWAY,round(math.degrees(bearing(Coordinates(*a),Coordinates(*b)))%360),FRC.FRC3,round(d))
l=LocationReferencePoint(*c,FRC.FRC3,FOW.SINGLE_CARRIAGEWAY,round(math.degrees(bearing(Coordinates(*c),Coordinates(*b)))%360),FRC.FRC7,0)
url='http://127.0.0.1:4200/resolve'
r=urllib.request.Request(url,json.dumps({'openlr':binary_encode(LineLocationReference([f,l],0.,0.))}).encode(),{'Content-Type':'application/json'})
x=json.load(urllib.request.urlopen(r,timeout=20))
assert x['geometry']['type']=='LineString' and x['confidence']>0.5,x
assert abs(x['geometry']['coordinates'][0][0]-8.)<.001 and \
abs(x['geometry']['coordinates'][-1][0]-8.0054)<.001,x
try:
 urllib.request.urlopen(urllib.request.Request(url,b'{"openlr":"***"}',{'Content-Type':'application/json'}),timeout=10)
 raise AssertionError('invalid reference accepted')
except urllib.error.HTTPError as error:
 assert error.code==400,error.code
print(json.dumps({'graphCounts':counts,'match':x,'invalidReferenceStatus':400,'geos':shapely.geos_version_string,'libpq':psycopg.pq.version()}))
"""


def runtime_smoke(image, identity, source, output):
    label = uuid.uuid4().hex
    network, db, app = [f"oc-image-{label}{suffix}" for suffix in ("", "-db", "-app")]
    resources = [("network", network), ("container", db), ("container", app)]
    possible = {
        identity["platformManifestDigest"],
        identity["configDigest"],
        f"sha256:{identity['ociIndexContentSha256']}",
    }
    confirmed_absent = set()
    for value in sorted(possible):
        inspection = command(["docker", "image", "inspect", value], check=False)
        if inspection.returncode == 0:
            continue
        if not absent(inspection, "image", value):
            fail("cannot confirm image presence; refusing to load or claim ownership")
        confirmed_absent.add(value)
    loaded = None
    record = {"identity": identity, "passed": False, "cleanup": [], "checks": {}}
    try:
        with (output / "load.log").open("w") as log:
            command(
                ["docker", "load", "--input", str(output / "image.oci.tar")],
                log=log,
                timeout=180,
            )
        ids = re.findall(
            r"Loaded image ID: (sha256:[0-9a-f]{64})", (output / "load.log").read_text()
        )
        if len(ids) != 1 or ids[0] not in possible:
            fail("Docker load returned an unbound image identity")
        loaded = ids[0]
        details = decode(command(["docker", "image", "inspect", loaded]).stdout)[0]
        if (
            details.get("Architecture") != "amd64"
            or details.get("Os") != "linux"
            or details.get("RootFS", {}).get("Layers") != identity["diffIds"]
        ):
            fail("loaded runtime filesystem/platform does not match OCI config")
        if (
            details.get("Id") != identity["configDigest"]
            and details.get("Descriptor", {}).get("digest") not in possible
        ):
            fail("Docker runtime identity is not bound to OCI data")
        if details.get("Config", {}).get("User") in (None, "", "root", "0", "0:0"):
            fail("service runtime unexpectedly runs as root")
        record["dockerRuntimeImageId"] = details["Id"]
        command(
            [
                "docker",
                "network",
                "create",
                "--internal",
                "--label",
                f"openconditions.qualification={label}",
                network,
            ]
        )
        command(
            [
                "docker",
                "run",
                "-d",
                "--name",
                db,
                "--label",
                f"openconditions.qualification={label}",
                "--network",
                network,
                "--platform",
                PLATFORM,
                "-e",
                "POSTGRES_USER=fixture",
                "-e",
                "POSTGRES_PASSWORD=fixture",
                "-e",
                "POSTGRES_DB=fixture",
                POSTGIS,
            ]
        )
        sql = [
            "docker",
            "exec",
            "-e",
            "PGPASSWORD=fixture",
            db,
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "fixture",
            "-d",
            "fixture",
            "-Atqc",
        ]
        deadline = time.monotonic() + 120
        while command([*sql, "select 1"], check=False).returncode:
            if time.monotonic() > deadline:
                fail("owned PostGIS database did not become ready")
            time.sleep(1)
        physical = command(
            [*sql, "select current_setting('server_version_num'),postgis_lib_version()"]
        ).stdout.strip()
        if not re.fullmatch(r"16[0-9]{4}\|3\.[0-9.]+", physical):
            fail("unexpected physical PostGIS version")
        record["physicalPostGIS"] = physical
        env = {
            "DATABASE_URL": f"postgresql://fixture:fixture@{db}:5432/fixture",
            "HOST": "0.0.0.0",
            "OPENCONDITIONS_CROSS_VALIDATE_SWEEP": "off",
            "OPENCONDITIONS_INGEST_FEEDS_EXCLUDE": "*",
            "OPENCONDITIONS_FEEDS_REMOTE_ENABLED": "false",
            "OPENCONDITIONS_GRANT_SECRET": uuid.uuid4().hex + uuid.uuid4().hex,
            "OPENCONDITIONS_REVIEWER_TOKEN": uuid.uuid4().hex + uuid.uuid4().hex,
        }
        args = [
            "docker",
            "run",
            "-d",
            "--name",
            app,
            "--label",
            f"openconditions.qualification={label}",
            "--network",
            network,
            "--platform",
            PLATFORM,
            "--health-interval",
            "2s",
            "--health-start-period",
            "0s",
        ]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        if image in ("ingest", "openlr-resolver"):
            args += [
                "--mount",
                f"type=bind,src={source / 'services/openlr-resolver/tests/fixtures/tiny_roads.osm'},"
                "dst=/fixture.osm,readonly",
            ]
        command([*args, loaded])
        deadline = time.monotonic() + 180
        while True:
            state = decode(command(["docker", "container", "inspect", app]).stdout)[0][
                "State"
            ]
            if not state["Running"]:
                fail("service exited before health qualification")
            if state.get("Health", {}).get("Status") == "healthy":
                break
            if time.monotonic() > deadline:
                fail("image's actual healthcheck did not become healthy")
            time.sleep(1)
        record["health"] = "healthy"
        if image == "openlr-resolver":
            record["checks"]["openlrGraphHttpNative"] = decode(
                command(["docker", "exec", app, "python", "-c", OPENLR_SMOKE]).stdout
            )
        else:
            port = IMAGES[image][1]
            code = (
                f"const r=await fetch('http://127.0.0.1:{port}/status');"
                f"const x=await r.json();"
                f"if(r.status!==200||x.status!=='ok')throw Error('bad status');"
                f"const k=await crypto.subtle.generateKey({{name:'ECDSA',namedCurve:'P-384'}},true,"
                f"['sign','verify']);"
                f"const b=new TextEncoder().encode('fixture');"
                f"const s=await crypto.subtle.sign({{name:'ECDSA',hash:'SHA-384'}},k.privateKey,b);"
                f"if(!await crypto.subtle.verify({{name:'ECDSA',hash:'SHA-384'}},k.publicKey,s,"
                f"b))throw Error('native crypto');"
                f"console.log(JSON.stringify(x));"
            )
            record["checks"]["httpNativeCrypto"] = decode(
                command(
                    ["docker", "exec", app, "node", "--input-type=module", "-e", code]
                ).stdout
            )
            tables = int(
                command(
                    [
                        *sql,
                        "select count(*) from information_schema.tables where table_schema='conditions'",
                    ]
                ).stdout.strip()
            )
            if tables < 10:
                fail("bundled migrations were not applied")
            record["checks"]["migratedTables"] = tables
            if image == "ingest":
                record["checks"]["osmiumVersion"] = command(
                    ["docker", "exec", app, "osmium", "--version"]
                ).stdout
                info = decode(
                    command(
                        [
                            "docker",
                            "exec",
                            app,
                            "osmium",
                            "fileinfo",
                            "-e",
                            "-j",
                            "/fixture.osm",
                        ]
                    ).stdout
                )
                if info.get("data", {}).get("count", {}).get("nodes", 0) < 5:
                    fail("osmium did not parse the fixture")
                record["checks"]["osmiumFileInfo"] = info
                code = (
                    f"import fs from 'node:fs';import {{Impit}} from 'impit';"
                    f"if(!fs.readFileSync('dist/feeds/credentials.jsonc').length||"
                    f"!fs.readFileSync('dist/drizzle/meta/_journal.json').length)"
                    f"throw Error('missing bundled inputs');"
                    f"const r=await new Impit({{browser:'chrome'}}).fetch('http://127.0.0.1:{port}/status');"
                    f"if(r.status!==200)throw Error('native impit');"
                )
                command(
                    ["docker", "exec", app, "node", "--input-type=module", "-e", code]
                )
                record["checks"]["bundledFeedsMigrationsImpit"] = True
        record["passed"] = True
    finally:
        for kind, name in reversed(resources):
            if kind == "container":
                found = command(["docker", kind, "inspect", name], check=False)
                if (
                    found.returncode == 0
                    and decode(found.stdout)[0]
                    .get("Config", {})
                    .get("Labels", {})
                    .get("openconditions.qualification")
                    == label
                ):
                    logs = command(["docker", "logs", name], check=False)
                    (output / f"{kind}-{name[-3:]}.log").write_text(
                        (logs.stdout or "") + (logs.stderr or "")
                    )
            record["cleanup"].append(remove_owned(kind, name, label))
        if loaded in confirmed_absent:
            removed = command(["docker", "image", "rm", loaded], check=False)
            missing = command(["docker", "image", "inspect", loaded], check=False)
            record["loadedImageCleanup"] = {
                "owned": True,
                "removalExit": removed.returncode,
                "absent": absent(missing, "image", loaded),
            }
        else:
            record["loadedImageCleanup"] = {"owned": False}
        write_json(output / "runtime.json", record)
    if not all(c["absent"] and c["removalExit"] == 0 for c in record["cleanup"]) or (
        record["loadedImageCleanup"]["owned"]
        and not record["loadedImageCleanup"]["absent"]
    ):
        fail("owned runtime cleanup could not be confirmed")


def scan_image(layout, output, work):
    cache = work / "trivy-cache"
    cache.mkdir()
    for mode, name in (("json", "scan.json"), ("cyclonedx", "sbom.cdx.json")):
        label = uuid.uuid4().hex
        container = f"oc-image-scan-{label}"
        try:
            args = [
                "docker",
                "run",
                "--rm",
                "--name",
                container,
                "--label",
                f"openconditions.qualification={label}",
                "--platform",
                PLATFORM,
                "--cpus",
                "2",
                "--memory",
                "2g",
                # Bind mounts retain runner ownership on Linux. With all
                # capabilities dropped, container root cannot bypass their DAC.
                "--user",
                f"{os.geteuid()}:{os.getegid()}",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=512m",
                "--mount",
                f"type=bind,src={layout},dst=/input,readonly",
                "--mount",
                f"type=bind,src={output},dst=/output",
                "--mount",
                f"type=bind,src={cache},dst=/cache",
                TRIVY,
                "image",
                "--cache-dir",
                "/cache",
                "--input",
                "/input",
                "--config",
                "",
                "--ignorefile",
                "",
                "--scanners",
                "vuln",
                "--list-all-pkgs",
                "--severity",
                "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
                "--parallel",
                "2",
                "--format",
                mode,
                "--output",
                f"/output/{name}",
                "--timeout",
                "15m",
                "--no-progress",
            ]
            # SBOM generation alone does not enforce a zero-finding policy.
            if mode == "json":
                args += ["--exit-code", "1"]
            with (output / f"{name}.log").open("w") as log:
                command(args, log=log, timeout=1000)
        finally:
            cleanup = remove_owned("container", container, label)
            if not cleanup["absent"] or cleanup["removalExit"] != 0:
                fail("scanner container cleanup could not be confirmed")
        if mode == "json":
            write_json(
                output / "scanner-db.json", json_file(cache / "db/metadata.json")
            )


def qualify(image, output, source):
    if output.exists():
        fail("output must be a new directory; never reuse a stale receipt")
    output.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory(prefix="oc-image-qualification-") as temporary:
            work = Path(temporary)
            checkout = snapshot(Path.cwd(), source, work)
            with (output / "build.log").open("w") as log:
                command(
                    [
                        "docker",
                        "buildx",
                        "build",
                        "--platform",
                        PLATFORM,
                        "--provenance=false",
                        "--progress=plain",
                        "--file",
                        str(checkout / f"services/{image}/Dockerfile"),
                        "--metadata-file",
                        str(output / "build-metadata.json"),
                        "--output",
                        f"type=oci,dest={output / 'image.oci.tar'}",
                        str(checkout / IMAGES[image][0]),
                    ],
                    log=log,
                    timeout=7200,
                )
            layout = work / "layout"
            identity = inspect_archive(output / "image.oci.tar", layout)
            write_json(output / "identity.json", identity)
            runtime_smoke(image, identity, checkout, output)
            scan_image(layout, output, work)
            result = verify_reports(output, image, source, execution())
            write_json(output / "qualified.json", result)
            return result
    except Exception:
        # All partial files are retained for debugging, but never a green marker.
        if (output / "qualified.json").exists():
            fail("unexpected qualification marker after failure")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--archive", required=True, type=Path)
    for mode in ("qualify", "collect", "verify"):
        cmd = sub.add_parser(mode)
        cmd.add_argument("--source", required=True)
        if mode in ("qualify", "verify"):
            cmd.add_argument("--image", required=True, choices=IMAGES)
            cmd.add_argument(
                "--output" if mode == "qualify" else "--directory",
                required=True,
                type=Path,
            )
        else:
            cmd.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    if args.mode == "inspect":
        result = inspect_archive(args.archive)
    else:
        if not re.fullmatch(r"[0-9a-f]{40}", args.source):
            fail("source must be an immutable 40-hex SHA")
        if args.mode == "collect":
            result = collect(args.directory, args.source)
        elif args.mode == "verify":
            result = verify_reports(
                args.directory, args.image, args.source, execution()
            )
        else:
            result = qualify(args.image, args.output.resolve(), args.source)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        OSError,
        KeyError,
        TypeError,
        tarfile.TarError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Image qualification failed: {error}", file=sys.stderr)
        sys.exit(1)
