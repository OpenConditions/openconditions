#!/usr/bin/env python3
"""Exact-byte publication mechanics. Live authority is deliberately fail-closed."""

import argparse
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import urllib.parse
import urllib.request
import urllib.error
import tempfile
import subprocess

SPEC = importlib.util.spec_from_file_location(
    "bundle", Path(__file__).with_name("bundle-product-release.py")
)
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)
P, N, Q = B.P, B.N, B.Q
ENVIRONMENT = "product-release"
MAIN_POLICY_SHA256 = "62d102aa1d0c34d53457598a206e9cf4d56ba2e6a81f8b94928008102b3102a7"
OWNER = {"login": "Medformatik", "id": 37375186}


def require_execution_authority(value):
    # No current producer proves actual prior-deployment upgrade, full rights,
    # optional-service applicability or operator/platform acceptance. Neither a
    # local receipt nor environment approval can invent those executed effects.
    raise ValueError(
        "Publication blocked: no trusted full-readiness execution producer; local claims and bounded rehearsal are insufficient"
    )


def protections(api, source, run_id, approved=False):
    repo = api.json(N.PREFIX)
    N.require(
        repo.get("id") == N.REPO_ID
        and repo.get("full_name") == N.REPO
        and repo.get("default_branch") == "main",
        "wrong publication repository",
    )
    N.require(
        api.json(N.PREFIX + "/git/ref/heads/main")["object"]["sha"] == source,
        "main advanced during approval",
    )
    rules = api.json(N.PREFIX + "/rulesets/18081110")
    N.require(
        Q.sha(
            N.canonical(
                {
                    k: rules.get(k)
                    for k in [
                        "name",
                        "target",
                        "enforcement",
                        "bypass_actors",
                        "conditions",
                        "rules",
                    ]
                }
            )
        )
        == MAIN_POLICY_SHA256,
        "main protection policy changed; reviewed baseline required",
    )
    env = api.json(N.PREFIX + "/environments/" + ENVIRONMENT)
    reviewers = [
        r
        for r in env.get("protection_rules", [])
        if r.get("type") == "required_reviewers"
    ]
    required = reviewers[0].get("reviewers", []) if len(reviewers) == 1 else []
    N.require(
        env.get("name") == ENVIRONMENT
        and N.positive(env.get("id"))
        and len(reviewers) == 1
        and reviewers[0].get("prevent_self_review") is False
        and len(required) == 1
        and required[0].get("type") == "User"
        and all(required[0].get("reviewer", {}).get(k) == v for k, v in OWNER.items()),
        "missing exact maintainer approval rule",
    )
    N.require(
        env.get("can_admins_bypass") is False
        and env.get("deployment_branch_policy")
        == {"protected_branches": False, "custom_branch_policies": True},
        "weak environment protection",
    )
    branches = api.json(
        N.PREFIX
        + "/environments/"
        + ENVIRONMENT
        + "/deployment-branch-policies?per_page=100"
    )
    N.require(
        branches.get("total_count") == 1
        and len(branches.get("branch_policies", [])) == 1
        and branches["branch_policies"][0].get("name") == "main"
        and branches["branch_policies"][0].get("type") == "branch",
        "environment must allow only main branch",
    )
    # Documented Administration(read) endpoint: GITHUB_TOKEN cannot request it.
    # 403/404/unknown fails; never substitute a variable or a local 'enabled' file.
    N.require(
        api.json(N.PREFIX + "/immutable-releases").get("enabled") is True,
        "native immutable releases not verified",
    )
    if approved:
        history = api.json(f"{N.PREFIX}/actions/runs/{run_id}/approvals")
        N.require(
            type(history) is list
            and any(
                x.get("state") == "approved"
                and all(x.get("user", {}).get(k) == v for k, v in OWNER.items())
                and any(
                    e.get("id") == env["id"] and e.get("name") == ENVIRONMENT
                    for e in x.get("environments", [])
                )
                for x in history
            ),
            "no attributed native environment approval",
        )
    return env


def assets(bundle, directories, provenance, execution, now):
    """Not a release approval: validate complete bytes, not reference-only assets."""
    B.validate_inventory(bundle)
    N.require("portable.json" in bundle, "missing actual portable/admission report")
    q = Q.decode(bundle["qualification.json"])
    N.require(
        set(execution) == {"readiness.json", "rehearsal.json", "rights-privacy.json"},
        "missing execution asset set",
    )
    B.readiness_claim(Q.decode(execution["readiness.json"]), q, now)
    N.require(
        Q.decode(execution["readiness.json"]) is not None,
        "missing complete readiness claim",
    )
    rehearsal = Q.decode(execution["rehearsal.json"])
    N.require(
        rehearsal.get("imageSourceSha") == q["imageSourceSha"]
        and rehearsal.get("manifestSourceSha") == q["manifestSourceSha"]
        and rehearsal.get("images") == q["imageEvidence"]["images"]
        and set(rehearsal.get("services", {})) == {"ingest", "contributions-api"}
        and all(x.get("outcome") == "passed" for x in rehearsal["services"].values()),
        "failed/mismatched rehearsal",
    )
    rights = Q.decode(execution["rights-privacy.json"])
    N.require(
        rights.get("success") is True
        and rights.get("numFailedTests") == 0
        and N.positive(rights.get("numPassedTests")),
        "missing/failed rights/privacy evidence",
    )

    N.require(
        set(directories) == set(Q.IMAGES) and set(provenance) == set(Q.IMAGES),
        "incomplete original image set",
    )
    files = {
        "extension.json": bundle["extension.json"],
        "qualification.json": bundle["qualification.json"],
        "portable.json": bundle["portable.json"],
        "image-evidence.json": bundle["artifact-references.json"],
        "release-notes.md": bundle[f"docs/release-notes/{q['version']}.md"],
        "candidate.json": bundle[f"docs/release-notes/{q['version']}.json"],
    }
    for role in ["ingest", "ingest-heavy", "contributions-api", "federation"]:
        files[role + ".service.json"] = bundle[f"services/{role}/service.json"]
    for role, directory in directories.items():
        original = q["imageEvidence"]
        report = Q.verify_reports(
            directory,
            role,
            q["imageSourceSha"],
            {
                "kind": "github",
                "runId": original["producer"]["runId"],
                "attempt": original["producer"]["runAttempt"],
            },
        )
        N.require(
            report == Q.json_file(directory / "qualified.json")
            and report["identity"]["platformManifestDigest"]
            == original["images"][role]["digest"],
            "original image substitution",
        )
        doc = Q.decode(provenance[role])
        N.require(
            doc["buildSourceSha"] == q["imageSourceSha"]
            and doc["producer"] == original["producer"]
            and doc["qualification"] == report,
            "provenance substitution",
        )
        files[role + ".provenance.json"] = provenance[role]
        for name in ["scan.json", "sbom.cdx.json", "qualified.json"]:
            files[role + "." + name] = Q.regular(directory / name)
    files.update(execution)
    inventory = {
        name: {"sha256": Q.sha(data), "size": len(data)}
        for name, data in sorted(files.items())
    }
    manifest = {
        "schemaVersion": 1,
        "version": q["version"],
        "imageSourceSha": q["imageSourceSha"],
        "manifestSourceSha": q["manifestSourceSha"],
        "tagTargetSha": q["tagTargetSha"],
        "eligibleUntil": q["eligibleUntil"],
        "inventory": inventory,
        "images": q["imageEvidence"]["images"],
        "releaseAuthority": False,
    }
    files["publication.json"] = N.canonical(manifest)
    return files


def native_fence(api, repo, qualification, source, run_id, clock):
    """Native checks can be reused once full readiness authority is implemented.

    Ignore only the exact owned tag in ordering history; publish separately
    rejects an existing tag/release whose commit/identity differs. Other history
    drift, expired/substituted artifacts or changed source remains a blocker.
    """
    protections(api, source, run_id, approved=True)
    n = qualification["imageEvidence"]
    a = n["producer"]
    b = qualification["manifestEvidence"]
    N.require(
        P.latest_manifest(
            api,
            qualification["manifestSourceSha"],
            b["producer"]["runId"],
            b["producer"]["runAttempt"],
            clock,
        )
        == b,
        "B main qualification changed",
    )
    N.require(
        N.inspect_run(
            api,
            qualification["imageSourceSha"],
            a["runId"],
            a["runAttempt"],
            clock(),
            True,
        )[0]
        == a,
        "A producer changed",
    )
    P.snapshot_image_artifacts(api, n, qualification["imageSourceSha"], a["runId"])
    P.policy(repo, source, qualification["imageSourceSha"])
    history = P.history(api)
    tag = "v" + qualification["version"]
    history = {
        key: [value for value in values if value != tag]
        for key, values in history.items()
    }
    N.require(
        Q.sha(N.canonical(history)) == qualification["historySha256"]
        and N.timestamp(qualification["eligibleUntil"]) > clock(),
        "history/expiry changed",
    )
    require_execution_authority(None)


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


class Registry:
    """OCI distribution copy of the inspected single-platform manifest bytes.

    request is a transport seam for owned HTTP fixtures. Production needs a
    GHCR-scoped bearer token (not a candidate-selected URL/credential).
    """

    def __init__(self, token, request=None):
        self.token = token
        if request is None:

            def request(method, url, data, headers):
                req = urllib.request.Request(
                    url, method=method, data=data, headers=headers
                )
                try:
                    response = urllib.request.build_opener(N.NoRedirect()).open(
                        req, timeout=120
                    )
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return (
                        response.status,
                        dict(response.headers),
                        response.read(N.MAX_BYTES),
                    )

        self.request = request

    def call(self, method, path, data=None, kind="application/octet-stream"):
        status, headers, body = self.request(
            method,
            "https://ghcr.io" + path,
            data,
            {
                "Authorization": "Bearer " + self.token,
                "Content-Type": kind,
                "Accept": "application/vnd.oci.image.manifest.v1+json",
            },
        )
        N.require(
            status
            in (
                [200, 404]
                if method == "GET"
                else [200, 404]
                if method == "HEAD"
                else [201, 202]
            ),
            "registry write/read failed or unknown; STOP, reconcile without retry",
        )
        return status, {k.lower(): v for k, v in headers.items()}, body

    def path(self, role, suffix):
        N.require(role in Q.IMAGES, "unknown image repository")
        return "/v2/openconditions/" + role + suffix

    def manifest(self, role, tag):
        status, headers, body = self.call("GET", self.path(role, "/manifests/" + tag))
        if status == 404:
            return None
        N.require(
            headers.get("docker-content-digest") == "sha256:" + Q.sha(body),
            "registry manifest digest differs",
        )
        return body

    def promote(self, role, version, archive, expected):
        existing = self.manifest(role, version)
        N.require(
            existing is None or "sha256:" + Q.sha(existing) == expected,
            "conflicting image tag",
        )
        if existing is not None:
            return
        with tempfile.TemporaryDirectory(prefix="oc-image-promotion-") as temp:
            layout = Path(temp) / "oci"
            identity = Q.inspect_archive(archive, layout)
            N.require(
                identity["platformManifestDigest"] == expected
                and identity["platform"] == Q.PLATFORM,
                "wrong original OCI/platform",
            )
            manifest = Q.regular(
                layout / "blobs/sha256" / expected.removeprefix("sha256:")
            )
            descriptors = Q.decode(manifest)
            for descriptor in [descriptors["config"], *descriptors["layers"]]:
                digest = descriptor["digest"]
                prefix = self.path(role, "/blobs/")
                if self.call("HEAD", prefix + digest)[0] == 200:
                    continue
                _, headers, _ = self.call(
                    "POST", self.path(role, "/blobs/uploads/"), b""
                )
                location = urllib.parse.urlsplit(headers.get("location", ""))
                N.require(
                    location.scheme in ["", "https"]
                    and location.netloc in ["", "ghcr.io"]
                    and location.path.startswith(self.path(role, "/blobs/uploads/"))
                    and not location.fragment,
                    "unsafe registry upload location",
                )
                path = location.path + ("?" + location.query if location.query else "")
                path += (
                    ("&" if location.query else "?")
                    + "digest="
                    + urllib.parse.quote(digest, safe="")
                )
                blob = Q.regular(
                    layout / "blobs/sha256" / digest.removeprefix("sha256:")
                )
                N.require(
                    "sha256:" + Q.sha(blob) == digest
                    and len(blob) == descriptor["size"],
                    "blob drift",
                )
                self.call("PUT", path, blob)
            self.call(
                "PUT",
                self.path(role, "/manifests/" + version),
                manifest,
                "application/vnd.oci.image.manifest.v1+json",
            )
        N.require(self.manifest(role, version) == manifest, "promoted bytes differ")

    def preview(self, role, version, expected):
        body = self.manifest(role, version)
        N.require(
            body is not None and "sha256:" + Q.sha(body) == expected,
            "version changed before preview",
        )
        if self.manifest(role, "preview") == body:
            return
        self.call(
            "PUT",
            self.path(role, "/manifests/preview"),
            body,
            "application/vnd.oci.image.manifest.v1+json",
        )
        N.require(self.manifest(role, "preview") == body, "preview readback mismatch")


def publish(api, registry, files, images, fence, clock=None):
    """One attempt per write. The trusted caller must recheck native authority.

    This core is exercised with owned HTTP adapters. The CLI below intentionally
    cannot supply a fence until full execution authority and token access exist.
    """
    clock = clock or (lambda: datetime.now(timezone.utc))
    expected = {
        "extension.json",
        "qualification.json",
        "portable.json",
        "image-evidence.json",
        "release-notes.md",
        "candidate.json",
        "publication.json",
        "readiness.json",
        "rehearsal.json",
        "rights-privacy.json",
        *[
            r + ".service.json"
            for r in ["ingest", "ingest-heavy", "contributions-api", "federation"]
        ],
        *[
            r + suffix
            for r in Q.IMAGES
            for suffix in [
                ".provenance.json",
                ".scan.json",
                ".sbom.cdx.json",
                ".qualified.json",
            ]
        ],
    }
    N.require(set(files) == expected, "missing/unknown publication asset")
    manifest = Q.decode(files["publication.json"])
    N.require(
        set(manifest)
        == set(
            "schemaVersion version imageSourceSha manifestSourceSha tagTargetSha eligibleUntil inventory images releaseAuthority".split()
        )
        and manifest["schemaVersion"] == 1
        and manifest["releaseAuthority"] is False,
        "unsupported publication manifest",
    )
    N.require(
        set(files) == {"publication.json", *manifest["inventory"]}
        and set(images) == set(Q.IMAGES),
        "partial publication inventory",
    )
    for name, identity in manifest["inventory"].items():
        N.require(
            "/" not in name
            and name not in [".", ".."]
            and identity == {"sha256": Q.sha(files[name]), "size": len(files[name])},
            "asset changed while approval waited",
        )
    version = manifest["version"]
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import{createRequire}from'node:module';const r=createRequire(import.meta.resolve('@changesets/cli/package.json'));if(r('semver').valid(process.argv[1])!==process.argv[1])process.exit(1)",
            version,
        ],
        cwd=P.TOOLS,
        check=True,
        capture_output=True,
        timeout=30,
    )
    # Version already validated by native qualification; no custom semver engine.
    q = Q.decode(files["qualification.json"])
    P.validate_receipt(q)
    N.require(
        all(
            manifest[k] == q[k]
            for k in [
                "version",
                "imageSourceSha",
                "manifestSourceSha",
                "tagTargetSha",
                "eligibleUntil",
            ]
        )
        and manifest["images"] == q["imageEvidence"]["images"],
        "publication candidate mismatch",
    )
    identity = Q.sha(files["publication.json"])
    tag = "v" + version
    marker = "publication:" + identity

    def check():
        N.require(
            N.timestamp(q["eligibleUntil"]) > clock(), "expired publication evidence"
        )
        fence()  # protections, approval, native A/B/artifacts/rehearsal/history/expiry
        N.require(
            N.timestamp(q["eligibleUntil"]) > clock(),
            "evidence expired during final authority read",
        )
        current_tag = api.optional(N.PREFIX + "/git/ref/tags/" + tag)
        N.require(
            current_tag is None
            or (
                current_tag.get("object", {}).get("type") == "commit"
                and current_tag["object"].get("sha") == q["tagTargetSha"]
            ),
            "tag drift",
        )
        current_release = api.optional(N.PREFIX + "/releases/tags/" + tag)
        if current_release:
            N.require(
                current_release.get("target_commitish") == q["tagTargetSha"]
                and current_release.get("body")
                == marker + "\n\n" + files["release-notes.md"].decode()
                and current_release.get("prerelease") is True,
                "release drift",
            )
        N.require(
            all(
                Q.sha(files[n]) == v["sha256"] for n, v in manifest["inventory"].items()
            )
            and Q.sha(files["publication.json"]) == identity,
            "approved bytes changed",
        )

    check()
    existing = api.optional(N.PREFIX + "/git/ref/tags/" + tag)
    N.require(
        existing is None
        or (
            existing.get("object", {}).get("type") == "commit"
            and existing.get("object", {}).get("sha") == q["tagTargetSha"]
        ),
        "conflicting tag",
    )
    release = api.optional(N.PREFIX + "/releases/tags/" + tag)

    def verify_release(r):
        N.require(
            r["tag_name"] == tag
            and r["target_commitish"] == q["tagTargetSha"]
            and r["prerelease"] is True
            and r["body"] == marker + "\n\n" + files["release-notes.md"].decode(),
            "conflicting release identity",
        )

    if release:
        verify_release(release)
    # Reject all version-tag conflicts before any promotion.
    for role in Q.IMAGES:
        expected = manifest["images"][role]["digest"]
        found = registry.manifest(role, version)
        N.require(
            found is None or "sha256:" + Q.sha(found) == expected,
            "conflicting image version",
        )
    for role in Q.IMAGES:
        check()
        registry.promote(
            role, version, images[role], manifest["images"][role]["digest"]
        )
    if existing is None:
        check()
        api.write(
            "POST",
            N.PREFIX + "/git/refs",
            {"ref": "refs/tags/" + tag, "sha": q["tagTargetSha"]},
        )
    check()
    if release is None:
        release = api.write(
            "POST",
            N.PREFIX + "/releases",
            {
                "tag_name": tag,
                "target_commitish": q["tagTargetSha"],
                "name": tag,
                "body": marker + "\n\n" + files["release-notes.md"].decode(),
                "draft": True,
                "prerelease": True,
                "make_latest": "false",
            },
        )
    verify_release(release)
    route = f"{N.PREFIX}/releases/{release['id']}"
    current = api.json(route + "/assets?per_page=100")
    N.require(
        len(current) < 100
        and len({x["name"] for x in current}) == len(current)
        and {x["name"] for x in current} <= set(files),
        "unknown/duplicate assets",
    )
    for name, data in files.items():
        found = next((x for x in current if x["name"] == name), None)
        if found is None:
            N.require(release["draft"], "cannot modify published assets")
            check()
            api.upload(release["id"], name, data)
        else:
            N.require(
                found.get("state") == "uploaded"
                and found.get("size") == len(data)
                and found.get("digest") == "sha256:" + Q.sha(data),
                "conflicting asset",
            )
    check()
    current = api.json(route + "/assets?per_page=100")
    N.require(
        len(current) == len(files)
        and {x["name"] for x in current} == set(files)
        and all(
            x.get("state") == "uploaded"
            and x.get("size") == len(files[x["name"]])
            and x.get("digest") == "sha256:" + Q.sha(files[x["name"]])
            for x in current
        ),
        "incomplete staged release",
    )
    for role in Q.IMAGES:
        N.require(
            "sha256:" + Q.sha(registry.manifest(role, version) or b"")
            == manifest["images"][role]["digest"],
            "promoted image drift",
        )
    if release["draft"]:
        check()
        api.write("PATCH", route, {"draft": False, "make_latest": "false"})
    published = api.json(route)
    verify_release(published)
    N.require(
        published["draft"] is False and published.get("immutable") is True,
        "publication/immutability not confirmed; preview unchanged",
    )
    for role in Q.IMAGES:
        check()
        registry.preview(role, version, manifest["images"][role]["digest"])
    return {
        "tag": tag,
        "identity": identity,
        "preview": "advanced after complete publication",
    }


def main():
    source = P.context(os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assess", action="store_true")
    args = parser.parse_args()
    if args.assess:
        # Assessment never means publication success. It produces false eligibility,
        # so missing producer/permissions do not request a meaningless approval.
        reason = "No trusted full-readiness execution producer. Immutable-release status needs Administration read, unavailable to GITHUB_TOKEN; no alternative credential is configured."
        try:
            protections(
                N.Github(os.environ.get("GH_TOKEN", "")),
                source,
                int(os.environ["GITHUB_RUN_ID"]),
            )
        except Exception:
            reason += " Native publication protections were not verified."
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a") as stream:
                stream.write("ready=false\n")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a") as stream:
                stream.write(
                    "\n## Publication remains blocked\n\n"
                    + reason
                    + " Review artifacts and bounded recovery remain useful; no release write was attempted.\n"
                )
        return
    # These are native job outputs, never normal operator inputs. No artifact is
    # consumed as execution authority while the producer/permission gaps remain.
    N.require(
        os.environ.get("REVIEW_ARTIFACT_ID", "").isdigit()
        and int(os.environ["REVIEW_ARTIFACT_ID"]) > 0
        and Q.DIGEST.fullmatch(
            "sha256:"
            + os.environ.get("REVIEW_ARTIFACT_DIGEST", "").removeprefix("sha256:")
        ),
        "missing approved native review artifact identity",
    )
    protections(
        N.Github(os.environ.get("GH_TOKEN", "")),
        source,
        int(os.environ["GITHUB_RUN_ID"]),
        approved=True,
    )
    require_execution_authority(None)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, ValueError)
            else "Publication failed; unknown writes require read-only reconciliation, no automatic retry/rollback"
        ) from None
