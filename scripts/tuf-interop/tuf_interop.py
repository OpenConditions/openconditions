"""python-tuf as an independent second implementation of the registry's TUF.

Two commands, both printing one JSON object on stdout:

``client REPO TRUSTED_ROOT CACHE``
    Runs the python-tuf ngclient workflow against a local repository (REPO
    holding ``metadata/`` and ``targets/``), trusting TRUSTED_ROOT on the first
    run and the CACHE on later ones, and downloads every target. Prints
    ``{"ok": true, "rootVersion": ..., "targets": {path: sha256}}`` or
    ``{"ok": false, "error": <exception class>, "message": ...}``.

``repo SCENARIO REGISTRY OUT``
    Writes a repository over the registry YAML files in REGISTRY with the
    python-tuf Metadata API into OUT, as SCENARIO describes, and prints
    ``{"trustedRoot": <path of the version 1 root>}``. The ``rollback``
    scenario writes release 2 to OUT and release 1 beside it, at ``older``.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse

from securesystemslib.signer import CryptoSigner
from tuf.api.exceptions import DownloadHTTPError
from tuf.api.metadata import (
    Metadata,
    MetaFile,
    Root,
    Snapshot,
    TargetFile,
    Targets,
    Timestamp,
)
from tuf.api.serialization.json import JSONSerializer
from tuf.ngclient import FetcherInterface, Updater

ROLES = ("root", "targets", "snapshot", "timestamp")


class FileFetcher(FetcherInterface):
    """Serves ``file:`` URLs, answering a missing file as an HTTP 404."""

    def _fetch(self, url: str) -> Iterator[bytes]:
        path = Path(unquote(urlparse(url).path))
        if not path.is_file():
            raise DownloadHTTPError(f"not found: {url}", 404)
        return iter([path.read_bytes()])


def client(repo: Path, trusted_root: Path, cache: Path) -> dict[str, object]:
    cache.mkdir(parents=True, exist_ok=True)
    downloads = cache / "targets"
    downloads.mkdir(exist_ok=True)
    if not (cache / "root.json").exists():
        shutil.copyfile(trusted_root, cache / "root.json")
    try:
        updater = Updater(
            metadata_dir=str(cache),
            metadata_base_url=(repo / "metadata").as_uri() + "/",
            target_dir=str(downloads),
            target_base_url=(repo / "targets").as_uri() + "/",
            fetcher=FileFetcher(),
            bootstrap=None,
        )
        updater.refresh()
        targets = Metadata[Targets].from_file(str(cache / "targets.json")).signed
        fetched: dict[str, str] = {}
        for path in sorted(targets.targets):
            info = updater.get_targetinfo(path)
            if info is None:
                raise LookupError(f"verified targets list {path} but it cannot be resolved")
            local = updater.download_target(info, str(downloads / path))
            fetched[path] = hashlib.sha256(Path(local).read_bytes()).hexdigest()
        root = Metadata[Root].from_file(str(cache / "root.json")).signed
    except Exception as error:  # noqa: BLE001 - the error class is the result
        return {"ok": False, "error": type(error).__name__, "message": str(error)}
    return {"ok": True, "rootVersion": root.version, "targets": fetched}


def expiry(days: float) -> datetime:
    return (datetime.now(UTC) + timedelta(days=days)).replace(microsecond=0)


class Repository:
    """A repository written with the Metadata API, one signer set per role."""

    def __init__(self, out: Path, registry: Path) -> None:
        self.metadata = out / "metadata"
        self.targets_dir = out / "targets"
        self.metadata.mkdir(parents=True, exist_ok=True)
        self.targets_dir.mkdir(parents=True, exist_ok=True)
        self.registry = registry
        self.signers = {role: [CryptoSigner.generate_ed25519()] for role in ROLES}
        self.thresholds = dict.fromkeys(ROLES, 1)

    def root(self, version: int, signers: list[CryptoSigner]) -> bytes:
        root = Root(version=version, expires=expiry(365), consistent_snapshot=False)
        for role in ROLES:
            for signer in self.signers[role]:
                root.add_key(signer.public_key, role)
            root.roles[role].threshold = self.thresholds[role]
        return self.sign(Metadata(root), signers, f"{version}.root.json")

    def release(
        self,
        version: int,
        *,
        targets_signers: list[CryptoSigner] | None = None,
        timestamp_expires: datetime | None = None,
    ) -> None:
        targets = Targets(version=version, expires=expiry(90))
        for source in sorted(self.registry.glob("*.yaml")):
            shutil.copyfile(source, self.targets_dir / source.name)
            targets.targets[source.name] = TargetFile.from_file(
                source.name, str(source), ["sha256", "sha512"]
            )
        targets_bytes = self.sign(
            Metadata(targets), targets_signers or self.signers["targets"], "targets.json"
        )
        snapshot = Snapshot(version=version, expires=expiry(7))
        snapshot.meta["targets.json"] = meta(version, targets_bytes)
        snapshot_bytes = self.sign(Metadata(snapshot), self.signers["snapshot"], "snapshot.json")
        timestamp = Timestamp(
            version=version,
            expires=timestamp_expires or expiry(1),
            snapshot_meta=meta(version, snapshot_bytes),
        )
        self.sign(Metadata(timestamp), self.signers["timestamp"], "timestamp.json")

    def sign(self, metadata: Metadata, signers: list[CryptoSigner], name: str) -> bytes:
        for signer in signers:
            metadata.sign(signer, append=True)
        data = metadata.to_bytes(JSONSerializer(compact=True))
        (self.metadata / name).write_bytes(data)
        return data


def meta(version: int, data: bytes) -> MetaFile:
    return MetaFile(
        version=version,
        length=len(data),
        hashes={"sha256": hashlib.sha256(data).hexdigest()},
    )


def repo(scenario: str, registry: Path, out: Path) -> dict[str, object]:
    repository = Repository(out, registry)
    trusted = repository.metadata / "1.root.json"
    if scenario in ("threshold-met", "threshold-unmet"):
        repository.signers["targets"] = [CryptoSigner.generate_ed25519() for _ in range(3)]
        repository.thresholds["targets"] = 2
    repository.root(1, repository.signers["root"])
    if scenario in ("rotation", "rotation-unauthorized"):
        old = repository.signers["root"]
        new = [CryptoSigner.generate_ed25519()]
        repository.signers["root"] = new
        repository.root(2, new if scenario == "rotation-unauthorized" else [*old, *new])
    if scenario == "threshold-met":
        repository.release(1, targets_signers=repository.signers["targets"][:2])
    elif scenario == "threshold-unmet":
        repository.release(1, targets_signers=repository.signers["targets"][:1])
    elif scenario == "expired":
        repository.release(1, timestamp_expires=expiry(-1))
    elif scenario == "rollback":
        # Version 2 now; the caller re-serves version 1 after a first sync.
        repository.release(2)
        older = out.parent / f"{out.name}-v1"
        shutil.copytree(out, older)
        for name in ("targets.json", "snapshot.json", "timestamp.json"):
            (older / "metadata" / name).unlink()
        stale = Repository(older, registry)
        stale.signers, stale.thresholds = repository.signers, repository.thresholds
        stale.release(1)
        return {"trustedRoot": str(trusted), "older": str(older)}
    else:
        repository.release(1)
    return {"trustedRoot": str(trusted)}


def main(argv: list[str]) -> int:
    command, *args = argv
    if command == "client" and len(args) == 3:
        result = client(Path(args[0]), Path(args[1]), Path(args[2]))
    elif command == "repo" and len(args) == 3:
        result = repo(args[0], Path(args[1]), Path(args[2]))
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
