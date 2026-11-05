#!/usr/bin/env python3
"""Publish the tested review artifact after native environment approval."""

from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import urllib.request
import urllib.error
import zipfile
import stat

SPEC = importlib.util.spec_from_file_location(
    "product", Path(__file__).with_name("qualify-product-release.py")
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
N, Q = P.N, P.N.Q
ROLES = list(Q.IMAGES)
ASSETS = {
    "extension.json",
    "candidate.json",
    "release-notes.md",
    "qualification.json",
    "rehearsal.json",
    "rights-privacy.json",
    "portable.json",
    *[
        r + ".service.json"
        for r in ["ingest", "ingest-heavy", "contributions-api", "federation"]
    ],
    *[
        r + s
        for r in ROLES
        for s in [".provenance.json", ".scan.json", ".sbom.cdx.json", ".qualified.json"]
    ],
}


def assets(repo, q, images, rehearsal, rights, portable):
    """Copy verified bytes, keeping the original A provenance and bounded results."""
    N.require(
        rehearsal["execution"].startswith("passed")
        and set(rehearsal["services"]) == {"ingest", "contributions-api"}
        and all(v["outcome"] == "passed" for v in rehearsal["services"].values())
        and all(rehearsal[k] == q[k] for k in ["imageSourceSha", "manifestSourceSha"]),
        "failed/mismatched recovery",
    )
    N.require(
        rights.get("success") is True
        and rights.get("numFailedTests") == 0
        and rights.get("numPassedTests", 0) > 0,
        "rights/privacy tests failed or missing",
    )
    source = q["manifestSourceSha"]
    version = q["version"]
    files = {
        "extension.json": P.git(repo, "show", f"{source}:extension.json"),
        "candidate.json": P.git(
            repo, "show", f"{source}:docs/release-notes/{version}.json"
        ),
        "release-notes.md": P.git(
            repo, "show", f"{source}:docs/release-notes/{version}.md"
        ),
        "qualification.json": N.canonical(q),
        "rehearsal.json": N.canonical(rehearsal),
        "rights-privacy.json": N.canonical(rights),
        "portable.json": N.canonical(portable),
    }
    for role in ["ingest", "ingest-heavy", "contributions-api", "federation"]:
        files[role + ".service.json"] = P.git(
            repo, "show", f"{source}:services/{role}/service.json"
        )
    for role in ROLES:
        provenance = Q.regular(images / "candidate" / (role + ".provenance.json"))
        report = Q.decode(provenance)["qualification"]
        N.require(
            report["sourceSha"] == q["imageSourceSha"]
            and report["identity"]["platformManifestDigest"]
            == q["imageEvidence"]["images"][role]["digest"],
            "image provenance mismatch",
        )
        files[role + ".provenance.json"] = provenance
        for name in ["scan.json", "sbom.cdx.json", "qualified.json"]:
            data = Q.regular(images / role / name)
            N.require(
                Q.decode(data) == report
                if name == "qualified.json"
                else Q.sha(data) == report["artifacts"][name],
                "report bytes changed",
            )
            files[role + "." + name] = data
    files["release.json"] = N.canonical(
        {
            "version": version,
            "source": source,
            "imageSource": q["imageSourceSha"],
            "images": q["imageEvidence"]["images"],
            "expiresAt": q["eligibleUntil"],
            "files": {
                k: {"sha256": Q.sha(v), "size": len(v)}
                for k, v in sorted(files.items())
            },
        }
    )
    verify(files)
    return files


def verify(files):
    N.require(set(files) == ASSETS | {"release.json"}, "missing/unknown release asset")
    manifest = Q.decode(files["release.json"])
    N.require(
        set(manifest)
        == set("version source imageSource images expiresAt files".split())
        and set(manifest["files"]) == ASSETS,
        "invalid asset inventory",
    )
    N.require(
        all(
            manifest["files"][k] == {"sha256": Q.sha(files[k]), "size": len(files[k])}
            for k in ASSETS
        ),
        "release asset changed",
    )
    q = Q.decode(files["qualification.json"])
    P.validate_receipt(q)
    N.require(
        manifest["source"] == q["manifestSourceSha"] == q["tagTargetSha"]
        and manifest["version"] == q["version"]
        and manifest["imageSource"] == q["imageSourceSha"]
        and manifest["images"] == q["imageEvidence"]["images"]
        and manifest["expiresAt"] == q["eligibleUntil"],
        "release identity mismatch",
    )
    return q


def emit(output, files):
    verify(files)
    output.mkdir()
    for name, data in files.items():
        N.require("/" not in name and "\\" not in name, "unexpected asset path")
        with (output / name).open("xb") as stream:
            stream.write(data)
        (output / name).chmod(0o644)


def admit(api, artifact_id, digest, run, attempt, source, work, clock):
    """Only the successful same-workflow qualify job's immutable native artifact."""
    workflow = api.json(N.PREFIX + "/actions/workflows/product-release.yml")
    current = api.json(f"{N.PREFIX}/actions/runs/{run}")
    N.require(
        workflow.get("path") == ".github/workflows/product-release.yml"
        and workflow.get("state") == "active"
        and current.get("id") == run
        and current.get("workflow_id") == workflow["id"]
        and current.get("event") == "workflow_dispatch"
        and current.get("head_branch") == "main"
        and current.get("head_sha") == source
        and current.get("repository", {}).get("id") == N.REPO_ID
        and current.get("head_repository", {}).get("id") == N.REPO_ID
        and current.get("run_attempt", 0) >= attempt,
        "untrusted publication run",
    )
    historical = api.json(f"{N.PREFIX}/actions/runs/{run}/attempts/{attempt}")
    N.require(
        all(
            historical.get(k) == current.get(k)
            for k in ["id", "head_sha", "workflow_id", "event", "head_branch"]
        )
        and historical.get("run_attempt") == attempt,
        "wrong proof attempt",
    )
    jobs = api.pages(f"{N.PREFIX}/actions/runs/{run}/attempts/{attempt}/jobs", "jobs")
    selected = [j for j in jobs if j.get("name") == "qualify"]
    N.require(
        len(selected) == 1
        and selected[0].get("conclusion") == "success"
        and selected[0].get("head_sha") == source,
        "qualification job failed/missing",
    )
    artifact = api.json(f"{N.PREFIX}/actions/artifacts/{artifact_id}")
    N.require(
        artifact.get("id") == artifact_id
        and artifact.get("name") == f"product-review-{run}-{attempt}"
        and artifact.get("digest") == "sha256:" + digest.removeprefix("sha256:")
        and artifact.get("expired") is False
        and N.timestamp(artifact["expires_at"]) > clock()
        and artifact.get("workflow_run", {}).get("id") == run
        and artifact["workflow_run"].get("head_sha") == source
        and artifact["workflow_run"].get("head_branch") == "main"
        and artifact["workflow_run"].get("repository_id") == N.REPO_ID
        and artifact["workflow_run"].get("head_repository_id") == N.REPO_ID,
        "wrong/expired review artifact",
    )
    upload = N.step(selected[0], "Retain review artifact")
    N.require(
        N.timestamp(upload["started_at"])
        <= N.timestamp(artifact["created_at"])
        <= N.timestamp(upload["completed_at"]),
        "artifact not from selected attempt",
    )
    archive = work / "review.zip"
    api.download(artifact, archive)
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        names = {"product-review/" + n for n in ASSETS | {"release.json"}}
        N.require(
            len(entries) == len(names)
            and {i.filename for i in entries} == names
            and sum(i.file_size for i in entries) <= N.MAX_BYTES,
            "unexpected review paths",
        )
        # Existing strict unpack handles flat names; prefixes are fixed here and
        # bytes stay in memory, never extracted to archive-controlled paths.
        N.require(
            all(
                not i.is_dir()
                and stat.S_IMODE(i.external_attr >> 16) == 0o644
                and (
                    not stat.S_IFMT(i.external_attr >> 16)
                    or stat.S_ISREG(i.external_attr >> 16)
                )
                and i.file_size <= 32 * 1024**2
                for i in entries
            ),
            "unsafe review member",
        )
        files = {n: z.read("product-review/" + n) for n in ASSETS | {"release.json"}}
    q = verify(files)
    N.require(
        q["manifestSourceSha"] == source
        and N.timestamp(q["eligibleUntil"]) > clock()
        and api.json(f"{N.PREFIX}/actions/artifacts/{artifact_id}") == artifact,
        "review source/artifact drift",
    )
    return files


class Github(N.Github):
    """Fixed GitHub origins; every write has one attempt and no redirects."""

    def optional(self, route):
        with self.api_response(route) as response:
            if response.status == 404:
                return None
            N.require(response.status == 200, "unexpected publication read status")
            return Q.decode(response.read(5 * 1024**2))

    def write(self, method, route, body):
        N.require(
            method in ["POST", "PATCH"] and route.startswith(N.PREFIX + "/"),
            "invalid publication write",
        )
        return self.send(
            method,
            "https://api.github.com" + route,
            N.canonical(body),
            "application/json",
        )

    def send(self, method, url, data, content_type):
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "Content-Type": content_type,
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )
        try:
            with urllib.request.build_opener(N.NoRedirect()).open(
                request, timeout=60
            ) as response:
                N.require(
                    response.status in [200, 201], "publication write rejected; stop"
                )
                return Q.decode(response.read(5 * 1024**2))
        except Exception:
            raise ValueError(
                "Publication write rejected or outcome unknown; STOP. Reconcile native identities read-only before another authorized attempt; no retry/rollback"
            ) from None

    def upload(self, release_id, name, data):
        N.require(N.positive(release_id) and "/" not in name, "invalid asset upload")
        return self.send(
            "POST",
            f"https://uploads.github.com{N.PREFIX}/releases/{release_id}/assets?name="
            + urllib.parse.quote(name, safe=""),
            data,
            "application/octet-stream",
        )


def tool(args, *, data=None, check=True):
    result = subprocess.run(
        ["skopeo", *args], input=data, capture_output=True, timeout=900
    )
    if check and result.returncode:
        raise ValueError(
            "OCI operation failed; inspect native state read-only before retry"
        )
    return result


class Registry:
    """Standard skopeo authentication/copy. No registry protocol implementation."""

    def __init__(self, authfile):
        self.authfile = str(authfile)

    def reference(self, role, tag):
        N.require(role in ROLES, "unknown image role")
        return "docker://ghcr.io/openconditions/" + role + ":" + tag

    def manifest(self, role, tag):
        result = tool(
            [
                "inspect",
                "--authfile",
                self.authfile,
                "--raw",
                self.reference(role, tag),
            ],
            check=False,
        )
        if result.returncode:
            message = result.stderr.decode(errors="replace").lower()
            N.require(
                "manifest unknown" in message or "name unknown" in message,
                "registry read failed; not absence",
            )
            return None
        return result.stdout

    def promote(self, role, version, archive, expected):
        before = self.manifest(role, version)
        N.require(
            before is None or "sha256:" + Q.sha(before) == expected,
            "conflicting image version",
        )
        if before is not None:
            return
        tool(
            [
                "--override-os",
                "linux",
                "--override-arch",
                "amd64",
                "copy",
                "--authfile",
                self.authfile,
                "--preserve-digests",
                "oci-archive:" + str(archive),
                self.reference(role, version),
            ]
        )
        N.require(
            "sha256:" + Q.sha(self.manifest(role, version) or b"") == expected,
            "promoted digest differs",
        )

    def preview(self, role, version, expected):
        N.require(
            "sha256:" + Q.sha(self.manifest(role, version) or b"") == expected,
            "version changed before preview",
        )
        if self.manifest(role, "preview") == self.manifest(role, version):
            return
        tool(
            [
                "copy",
                "--authfile",
                self.authfile,
                "--preserve-digests",
                "docker://ghcr.io/openconditions/" + role + "@" + expected,
                self.reference(role, "preview"),
            ]
        )
        N.require(
            "sha256:" + Q.sha(self.manifest(role, "preview") or b"") == expected,
            "preview update not confirmed",
        )


def publish(api, registry, files, images, fence, clock=None):
    q = verify(files)
    clock = clock or (lambda: datetime.now(timezone.utc))
    tag = "v" + q["version"]
    marker = "publication:" + Q.sha(files["release.json"])
    body = marker + "\n\n" + files["release-notes.md"].decode()

    def check():
        verify(files)
        fence()
        N.require(
            N.timestamp(q["eligibleUntil"]) > clock(), "expired publication evidence"
        )

    def release_identity(value):
        N.require(
            value["tag_name"] == tag
            and value["target_commitish"] == q["tagTargetSha"]
            and value["prerelease"] is True
            and value["body"] == body,
            "conflicting release identity",
        )

    def asset_set(release, complete=False):
        entries = api.json(f"{N.PREFIX}/releases/{release['id']}/assets?per_page=100")
        N.require(
            len(entries) < 100
            and len({x["name"] for x in entries}) == len(entries)
            and {x["name"] for x in entries} <= set(files),
            "unknown/duplicate assets",
        )
        N.require(
            all(
                x.get("state") == "uploaded"
                and x.get("size") == len(files[x["name"]])
                and x.get("digest") == "sha256:" + Q.sha(files[x["name"]])
                for x in entries
            ),
            "conflicting asset",
        )
        if complete:
            N.require(
                {x["name"] for x in entries} == set(files), "incomplete release assets"
            )
        return {x["name"] for x in entries}

    check()
    existing = api.optional(N.PREFIX + "/git/ref/tags/" + tag)
    N.require(
        existing is None
        or (
            existing.get("object", {}).get("type") == "commit"
            and existing["object"].get("sha") == q["tagTargetSha"]
        ),
        "conflicting tag",
    )
    release = api.optional(N.PREFIX + "/releases/tags/" + tag)
    uploaded = set()
    if release:
        release_identity(release)
        uploaded = asset_set(release)
    for role in ROLES:
        current = registry.manifest(role, q["version"])
        N.require(
            current is None
            or "sha256:" + Q.sha(current)
            == q["imageEvidence"]["images"][role]["digest"],
            "conflicting image version",
        )
    for role in ROLES:
        N.require(N.timestamp(q["eligibleUntil"]) > clock(), "expired image evidence")
        registry.promote(
            role,
            q["version"],
            images / role / "image.oci.tar",
            q["imageEvidence"]["images"][role]["digest"],
        )
    if existing is None:
        api.write(
            "POST",
            N.PREFIX + "/git/refs",
            {"ref": "refs/tags/" + tag, "sha": q["tagTargetSha"]},
        )
    if release is None:
        release = api.write(
            "POST",
            N.PREFIX + "/releases",
            {
                "tag_name": tag,
                "target_commitish": q["tagTargetSha"],
                "name": tag,
                "body": body,
                "draft": True,
                "prerelease": True,
                "make_latest": "false",
            },
        )
    release_identity(release)
    for name, data in files.items():
        if name not in uploaded:
            N.require(release["draft"], "cannot overwrite published assets")
            N.require(
                N.timestamp(q["eligibleUntil"]) > clock(), "expired asset evidence"
            )
            api.upload(release["id"], name, data)
    asset_set(release, complete=True)
    for role in ROLES:
        N.require(
            "sha256:" + Q.sha(registry.manifest(role, q["version"]) or b"")
            == q["imageEvidence"]["images"][role]["digest"],
            "image changed",
        )
    check()
    route = f"{N.PREFIX}/releases/{release['id']}"
    latest_tag = api.json(N.PREFIX + "/git/ref/tags/" + tag)
    N.require(
        latest_tag.get("object") == {"type": "commit", "sha": q["tagTargetSha"]}
        or (
            latest_tag.get("object", {}).get("type") == "commit"
            and latest_tag["object"].get("sha") == q["tagTargetSha"]
        ),
        "tag changed before publish",
    )
    release = api.json(route)
    release_identity(release)
    asset_set(release, complete=True)
    if release["draft"]:
        api.write("PATCH", route, {"draft": False, "make_latest": "false"})
    published = api.json(route)
    release_identity(published)
    N.require(
        published["draft"] is False and published.get("immutable") is True,
        "release is not immutable; preview unchanged. Check owner immutability setup.",
    )
    check()
    for role in ROLES:
        N.require(N.timestamp(q["eligibleUntil"]) > clock(), "expired preview evidence")
        registry.preview(
            role, q["version"], q["imageEvidence"]["images"][role]["digest"]
        )
    return tag


def main():
    source = P.context(os.environ)
    N.require(
        os.environ.get("RELEASE_OPERATION") == "publish",
        "explicit publish intent required",
    )
    api = Github(os.environ.get("GH_TOKEN", ""))
    # Native job approval is authoritative; this merely catches an accidentally
    # auto-created unprotected environment. No approval-history/admin API replay.
    environment = api.json(N.PREFIX + "/environments/product-release")
    N.require(
        any(
            r.get("type") == "required_reviewers" and r.get("reviewers")
            for r in environment.get("protection_rules", [])
        ),
        "configure the protected product-release environment first",
    )
    run = int(os.environ["GITHUB_RUN_ID"])
    attempt = int(os.environ["PROOF_ATTEMPT"])

    def clock():
        return datetime.now(timezone.utc)

    with tempfile.TemporaryDirectory(prefix="oc-publication-") as temporary:
        work = Path(temporary)
        files = admit(
            api,
            int(os.environ["REVIEW_ARTIFACT_ID"]),
            os.environ["REVIEW_ARTIFACT_DIGEST"],
            run,
            attempt,
            source,
            work,
            clock,
        )
        q = verify(files)

        def fence():
            P.final_fences(api, Path.cwd(), q, source, clock, resume=True)

        fence()
        images = work / "images"
        native = N.validate(
            api,
            q["imageSourceSha"],
            q["imageEvidence"]["producer"]["runId"],
            q["imageEvidence"]["producer"]["runAttempt"],
            directory=images,
        )
        N.require(native == q["imageEvidence"], "image evidence changed since review")
        authfile = work / "auth.json"
        tool(
            [
                "login",
                "--authfile",
                str(authfile),
                "--username",
                os.environ["GITHUB_ACTOR"],
                "--password-stdin",
                "ghcr.io",
            ],
            data=(os.environ["GH_TOKEN"] + "\n").encode(),
        )
        tag = publish(api, Registry(authfile), files, images, fence)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a") as stream:
                stream.write(
                    f"## Published {tag}\n\nOriginal tested images, complete immutable release and preview are confirmed.\n"
                )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a") as stream:
                stream.write(
                    "\n## Publication stopped\n\nInspect logs and partial GitHub/GHCR state read-only before retrying the identical unexpired candidate. Preview may be partially updated; no automatic rollback is performed.\n"
                )
        raise SystemExit(
            str(error)
            if isinstance(error, ValueError)
            else "Publication stopped; inspect partial native state read-only before retry. No automatic rollback."
        ) from None
