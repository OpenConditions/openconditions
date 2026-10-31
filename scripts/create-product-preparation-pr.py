#!/usr/bin/env python3
"""Only create an identity-bound preparation branch/PR. Never update refs or merge."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import stat
import zipfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "product", Path(__file__).with_name("qualify-product-release.py")
)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
N, Q = P.N, P.N.Q


class Github(N.Github):
    def optional(self, route):
        with self.api_response(route) as response:
            if response.status == 404:
                return None
            N.require(response.status == 200, "Unexpected resource response; stop")
            return Q.decode(response.read(5 * 1024**2))

    def mutate(self, route, body):
        # One POST, no redirects/retries, including unknown outcomes. Never PATCH refs.
        request = urllib.request.Request(
            "https://api.github.com" + route,
            data=N.canonical(body),
            method="POST",
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )
        try:
            with urllib.request.build_opener(N.NoRedirect()).open(
                request, timeout=30
            ) as response:
                N.require(
                    response.status in [200, 201], "Preparation write rejected; stop"
                )
                return Q.decode(response.read(5 * 1024**2))
        except urllib.error.HTTPError as error:
            raise ValueError(
                f"POST {route} rejected HTTP {error.code}; no retry. Preserve partial resources and inspect Actions PR-creation permissions."
            ) from None


def same(value, expected):
    return isinstance(value, dict) and all(
        k in value and type(value[k]) is type(v) and value[k] == v
        for k, v in expected.items()
    )


def pr_body(version, source, identity):
    return f"""Prepare product {version} from image source `{source}`.

Identity: `release-preparation:{identity}`

Review the seven metadata/notes files and their original A image evidence. No runtime, configuration, dependency or service-membership change is proposed. This is not release/readiness approval.

GitHub may not start required checks for a GITHUB_TOKEN-created PR. A maintainer must approve/run the normal required PR checks if needed; this job does not dispatch or bypass them. After review and user merge, run Product prepare and review → review for {version}.

Product release: operator-impact docs/release-notes/{version}.md

Package release: none — Product descriptors and curated notes only; qualified OCPI source, types, exports and build/runtime dependencies are unchanged.
"""


def create(
    api,
    repo,
    source,
    artifact,
    expected_digest,
    current_run,
    current_attempt,
    *,
    clock=None,
):
    clock = clock or (lambda: datetime.now(timezone.utc))
    P.owning_checkout(repo)
    N.require(
        P.git(repo, "rev-parse", "HEAD").decode().strip() == source
        and not P.git(repo, "status", "--porcelain").strip(),
        "Caller checkout changed",
    )
    P.policy(repo, source, source)
    N.require(
        N.positive(current_run)
        and N.positive(current_attempt)
        and N.positive(artifact),
        "Invalid internal job identities",
    )
    route = f"{N.PREFIX}/actions/artifacts/{artifact}"
    uploaded = api.json(route)
    expected_digest = "sha256:" + expected_digest.removeprefix("sha256:")
    N.require(
        Q.DIGEST.fullmatch(expected_digest)
        and same(
            uploaded,
            {
                "id": artifact,
                "digest": expected_digest,
                "name": f"product-review-{current_run}-{current_attempt}",
                "expired": False,
            },
        )
        and same(uploaded.get("workflow_run"), {"id": current_run, "head_sha": source})
        and N.timestamp(uploaded["expires_at"]) > clock(),
        "Wrong preparation artifact identity",
    )
    with tempfile.TemporaryDirectory(prefix="oc-preparation-pr-") as temporary:
        work = Path(temporary)
        archive = work / "artifact.zip"
        api.download(
            uploaded, archive
        )  # Native ZIP digest/size checked, token not forwarded.
        receipt_name = "product-review.receipt.json"
        with zipfile.ZipFile(archive) as z:
            entries = z.infolist()
            names = [i.filename for i in entries]
            candidates = [
                re.fullmatch(
                    r"product-review/docs/release-notes/([0-9][A-Za-z0-9.+-]*)\.json", n
                )
                for n in names
            ]
            versions = [m[1] for m in candidates if m]
            N.require(len(versions) == 1, "Unexpected candidate path")
            version = versions[0]
            paths = [
                "extension.json",
                *[
                    f"services/{s}/service.json"
                    for s in [
                        "ingest",
                        "ingest-heavy",
                        "contributions-api",
                        "federation",
                    ]
                ],
                f"docs/release-notes/{version}.json",
                f"docs/release-notes/{version}.md",
            ]
            N.require(
                set(names) == {receipt_name, *["product-review/" + p for p in paths]}
                and len(names) == 8,
                "Missing/duplicate/unexpected prepared paths",
            )
            # Fixed members read into memory; never extract archive-controlled paths.
            for info in entries:
                mode = info.external_attr >> 16
                N.require(
                    not info.is_dir()
                    and (not stat.S_IFMT(mode) or stat.S_ISREG(mode))
                    and stat.S_IMODE(mode) == 0o644
                    and info.file_size
                    <= (
                        16 * 1024**2
                        if info.filename.endswith(".json")
                        else 32 * 1024**2
                    ),
                    "Nonregular/mode/size preparation entry",
                )
            receipt = Q.decode(z.read(receipt_name))
            proof = receipt["localProof"]
            N.require(proof["version"] == version, "Prepared version mismatch")
            files = {p: z.read("product-review/" + p) for p in paths}
        N.require(
            receipt["kind"] == "Native A preparation binding only"
            and receipt["releaseAuthority"] is False
            and receipt["nativeBQualified"] is False
            and proof["imageSourceSha"] == source
            and set(proof["metadataSha256"]) == set(paths)
            and proof["contextProof"]["equal"] is True,
            "Unqualified preparation receipt",
        )
        N.require(
            all(Q.sha(data) == proof["metadataSha256"][p] for p, data in files.items()),
            "Prepared bytes substituted",
        )
        native = receipt["nativeImageEvidence"]
        N.require(
            native["buildSourceSha"] == source
            and native["images"] == proof["images"]
            and receipt["eligibleUntil"] == native["eligibleUntil"],
            "Wrong image binding",
        )
        tree = proof["preparedTreeOid"]
        N.require(
            isinstance(tree, str) and re.fullmatch(r"[a-f0-9]{40}", tree),
            "Invalid prepared tree",
        )
        identity = Q.sha(
            N.canonical(
                {"source": source, "tree": tree, "metadata": proof["metadataSha256"]}
            )
        )
        branch = "release/prepare-" + version
        body = pr_body(version, source, identity)
        title = "chore(release): prepare " + version
        ref_route = N.PREFIX + "/git/ref/heads/" + urllib.parse.quote(branch, safe="/")
        pulls_route = (
            N.PREFIX
            + "/pulls?"
            + urllib.parse.urlencode(
                {
                    "state": "all",
                    "head": "OpenConditions:" + branch,
                    "base": "main",
                    "per_page": 100,
                }
            )
        )

        def fence():
            run = api.json(f"{N.PREFIX}/actions/runs/{current_run}")
            N.require(
                same(
                    run,
                    {
                        "id": current_run,
                        "head_sha": source,
                        "head_branch": "main",
                        "event": "workflow_dispatch",
                        "run_attempt": current_attempt,
                        "path": ".github/workflows/product-release.yml",
                    },
                )
                and same(run.get("repository"), {"id": N.REPO_ID}),
                "Wrong preparation workflow run",
            )
            jobs = api.pages(
                f"{N.PREFIX}/actions/runs/{current_run}/attempts/{current_attempt}/jobs",
                "jobs",
            )
            N.require(
                len(
                    [
                        j
                        for j in jobs
                        if j.get("name") == "qualify"
                        and j.get("status") == "completed"
                        and j.get("conclusion") == "success"
                    ]
                )
                == 1,
                "Preparation validation job not successful",
            )
            N.require(
                api.json(route) == uploaded
                and N.timestamp(uploaded["expires_at"]) > clock()
                and N.timestamp(native["eligibleUntil"]) > clock(),
                "Preparation evidence expired/changed",
            )
            N.require(
                api.json(N.PREFIX + "/git/ref/heads/main").get("object", {}).get("sha")
                == source,
                "Main advanced; stop without rebasing",
            )
            producer = native["producer"]
            N.require(
                P.latest_manifest(
                    api, source, producer["runId"], producer["runAttempt"], clock
                )["producer"]
                == producer,
                "Image producer changed",
            )
            P.snapshot_image_artifacts(api, native, source, producer["runId"])
            history = P.history(api)
            N.require(
                Q.sha(
                    json.dumps(
                        history["tags"] + history["releases"],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ).encode()
                )
                == proof["historySha256"],
                "Version history changed",
            )

        def post(path, payload):
            fence()
            return api.mutate(N.PREFIX + path, payload)

        fence()
        existing = api.optional(ref_route)
        prs = api.json(pulls_route)
        N.require(isinstance(prs, list) and len(prs) < 100, "Incomplete PR inventory")
        message = "Prepare " + version + "\n\nrelease-preparation:" + identity
        if existing is not None:
            # Ref ownership alone is unknowable. Require an existing exact bot PR too.
            N.require(
                len(prs) == 1
                and prs[0].get("user", {}).get("login") == "github-actions[bot]",
                "Existing orphan/human branch; do not overwrite",
            )
            commit = api.json(N.PREFIX + "/git/commits/" + existing["object"]["sha"])
            N.require(
                commit["tree"]["sha"] == tree
                and [p["sha"] for p in commit["parents"]] == [source]
                and commit["message"] == message,
                "Existing branch content conflict",
            )
            pr = prs[0]
        else:
            N.require(not prs, "Existing PR history conflicts with reserved branch")
            base = api.json(N.PREFIX + "/git/commits/" + source)
            N.require(
                base["sha"] == source
                and base["tree"]["sha"]
                == P.git(repo, "rev-parse", source + "^{tree}").decode().strip(),
                "Source tree drift",
            )
            created = post(
                "/git/trees",
                {
                    "base_tree": base["tree"]["sha"],
                    "tree": [
                        {
                            "path": p,
                            "mode": "100644",
                            "type": "blob",
                            "content": files[p].decode("utf8"),
                        }
                        for p in paths
                    ],
                },
            )
            N.require(
                created["sha"] == tree, "Prepared tree differs; no branch created"
            )
            commit = post(
                "/git/commits",
                {
                    "message": message,
                    "tree": tree,
                    "parents": [source],
                    "author": {
                        "name": "github-actions[bot]",
                        "email": "41898282+github-actions[bot]@users.noreply.github.com",
                    },
                },
            )
            N.require(
                isinstance(commit.get("sha"), str)
                and re.fullmatch(r"[a-f0-9]{40}", commit["sha"]),
                "Invalid created commit identity",
            )
            readback = api.json(N.PREFIX + "/git/commits/" + commit["sha"])
            N.require(
                readback["tree"]["sha"] == tree
                and [p["sha"] for p in readback["parents"]] == [source]
                and readback["message"] == message,
                "Created commit readback differs; no branch created",
            )
            created_ref = post(
                "/git/refs", {"ref": "refs/heads/" + branch, "sha": commit["sha"]}
            )
            N.require(
                created_ref.get("ref") == "refs/heads/" + branch
                and created_ref["object"]["sha"] == commit["sha"]
                and api.optional(ref_route) == created_ref,
                "Branch readback differs; stop",
            )
            pr = post(
                "/pulls",
                {
                    "title": title,
                    "body": body,
                    "head": branch,
                    "base": "main",
                    "draft": False,
                },
            )

        def check_pr(value):
            N.require(
                same(
                    value,
                    {
                        "state": "open",
                        "merged_at": None,
                        "auto_merge": None,
                        "title": title,
                        "body": body,
                    },
                )
                and same(value.get("user"), {"login": "github-actions[bot]"})
                and same(value.get("head"), {"sha": commit["sha"], "ref": branch})
                and same(value["head"].get("repo"), {"full_name": N.REPO})
                and same(value.get("base"), {"ref": "main", "sha": source}),
                "Existing/created PR identity conflict",
            )

        check_pr(pr)
        number = pr["number"]
        N.require(N.positive(number), "Invalid PR number")
        if "Medformatik" not in [a["login"] for a in pr.get("assignees", [])]:
            post(f"/issues/{number}/assignees", {"assignees": ["Medformatik"]})
        missing = sorted(
            {"ci", "documentation"} - {a["name"] for a in pr.get("labels", [])}
        )
        if missing:
            post(f"/issues/{number}/labels", {"labels": missing})
        fence()
        fresh = api.json(N.PREFIX + f"/pulls/{number}")
        check_pr(fresh)
        N.require(
            "Medformatik" in [a["login"] for a in fresh.get("assignees", [])]
            and {"ci", "documentation"}.issubset(
                {a["name"] for a in fresh.get("labels", [])}
            )
            and api.optional(ref_route)["object"]["sha"] == commit["sha"],
            "PR metadata/ref readback differs",
        )
        return fresh["html_url"]


def main():
    source = P.context(os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-id", type=int, required=True)
    parser.add_argument("--artifact-digest", required=True)
    args = parser.parse_args()
    url = create(
        Github(os.environ.get("GH_TOKEN", "")),
        Path.cwd(),
        source,
        args.artifact_id,
        args.artifact_digest,
        int(os.environ["GITHUB_RUN_ID"]),
        int(os.environ["GITHUB_RUN_ATTEMPT"]),
    )
    Path(os.environ["GITHUB_STEP_SUMMARY"]).write_text(
        f"# Preparation PR ready\n\nReview {url}\n\nApprove/run normal required PR checks if GitHub does not start them for the bot PR. After review and user merge, run **review** for the committed version. Readiness and publication remain blocked. No automatic approval, merge, dispatch or publication occurred.\n"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Preparation write failed; stop and reconcile read-only, no retry/rollback",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
