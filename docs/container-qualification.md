# Nonpublishing container qualification

CI builds ingest, contributions-api and federation with repository-root contexts, and openlr-resolver
with its service-local context. The exact checked-out Git SHA is archived with replacement objects
disabled, regular source bytes checked against Git blob identities, and executable modes preserved.
Untracked files, local dependencies, credentials and scratch do not enter the archived build context.
No branch title, body or ref supplies a build command or image path.

The four-image matrix runs on ordinary Linux/amd64 PR/main CI with read-only repository permissions.
Each image gets an isolated runner, disposable Docker 29.9.2 daemon with the containerd image store,
and Buildx 0.38.1. At most two matrix jobs run concurrently. Local AMD64 execution on an ARM64 Docker
host is emulated; it does not qualify native AMD64 performance, ARM64 images, production deployments,
or an architecture support matrix. Existing tag publication is unchanged and is never dispatched here.
There is no registry login, push, package write, OIDC or privileged artifact consumer in this pipeline.

## What must execute

`scripts/qualify-container-images.py qualify` builds the selected fixed recipe into an untagged OCI
archive. The image must run as a non-root user, become healthy using its actual image healthcheck, and
pass runtime/native probes on a fresh internal Docker network and owned PG16 database. No host port is
published, no operator database or credentials are used, and provider egress is unavailable. Test-only
grant/reviewer credentials are freshly generated. Database readiness uses a real TCP query to the
fixture database, rather than accepting the image's temporary bootstrap server.

- Every Node service applies its bundled migrations, returns its status document and exercises native
  WebCrypto. Federation's default-disabled status is recorded; this does not prove enabled peer or
  public-host behavior. Independent federation interoperability remains a separate CI gate.
- Ingest additionally exercises its compiled osmium binary on a real OSM fixture, verifies baked feed
  credentials and migration metadata, and makes an Impit native request to its own health endpoint.
  Polling is explicitly excluded and the remote feed layer stays off.
- The resolver imports its musl/native dependencies, builds the five-node/five-edge OSM fixture graph,
  loads it into PostGIS and resolves a real binary OpenLR reference through HTTP. Invalid reference
  rejection is also checked. Its packaged libpq version is separate from the actual PG16 server major.

Owned containers, networks and newly loaded images are removed. Resource labels and exact identities
are checked before deletion; pre-existing images are preserved. A daemon/permission error does not
count as confirmed cleanup. Cleanup failure prevents qualification. Build caches are not pruned.

## Scan and artifact identity

The pinned Trivy 0.76.1 container scans the verified OCI layout without a Docker socket. It receives
only the read-only layout, a disposable DB cache and its output directory. It runs with the invoking
numeric UID/GID and an explicit `/cache` path so Linux bind mounts remain writable with all capabilities
dropped. Scanner errors fail, all
severities including low/unknown are blocking, and no ignore file, configuration override or unfixed
exception is loaded. The vulnerability DB identity/timestamps are retained and must be current at scan
time. Separate OS and language package inventories are required. CycloneDX generation alone cannot
satisfy the vulnerability gate.

Receipts distinguish:

| Identity                 | Meaning                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `archiveContentSha256`   | SHA-256 of the exact retained OCI tar bytes                                                                             |
| `ociIndexContentSha256`  | SHA-256 of the archive's `index.json` bytes                                                                             |
| `platformManifestDigest` | OCI platform manifest blob digest, with its full blob graph verified                                                    |
| `configDigest`           | Image configuration blob digest; also Trivy's image identity                                                            |
| `dockerRuntimeImageId`   | The actual Docker engine's loaded-image identifier; containerd and classic stores can expose different identifier forms |
| Artifact hashes          | Exact scan, SBOM, runtime, build-metadata and vulnerability-DB receipt bytes                                            |

The loaded filesystem DiffIDs and platform must match the verified configuration. Build metadata,
scan and SBOM must refer to the same image. These local OCI digests are not published registry
manifest/index authority. The scanner's package inventory and native runtime records are evidence,
not proof that every bundled or custom-compiled component has a complete vulnerability/license
classification. Production dependency audits, independent interoperability and later notice/security
qualification remain separate requirements. No blanket security or licensing clearance is claimed.

CI retains archives and evidence for three days, including partial failure logs. `qualified.json` is
written only after all checks pass; an output directory cannot be reused. The aggregate re-reads all
four archives and report bindings, requires every image role/source/run/attempt, and rejects missing,
failed, cancelled or skipped matrix coverage. The existing `required CI` and full-main marker include
this aggregate on full events. Weekly audit-only CI deliberately skips image work.

## Local use and limits

With Python 3.14, Docker 29 with OCI import/containerd storage and Buildx 0.38.1:

```bash
python scripts/qualify-container-images.py qualify --image ingest --source "$(git rev-parse HEAD)" --output /tmp/unique-image-evidence
```

Run local images serially on constrained hosts. The baseline concurrent emulated builds exhausted an
8 GB Docker VM; the serial retry passed, and neither attempt is a performance cohort. Helpers use only
Python's standard library. Normal hooks still run no Docker or workspace suite. To update pinned
Docker/Buildx/Trivy/PostGIS tools, re-run protocol tests and actual image/native qualification; do not
silently add supported architectures.

All receipts explicitly lack release authority. PR/local artifacts are never promoted by this work.
Trusted-main candidate source/run/attempt/digest/SBOM/provenance acceptance is a later step. Image-source
A and post-merge release metadata B require separate protected-main evidence and exact descriptor-field
validation. Context reuse also remains blocked until the separate metadata-context change is merged
and qualified. This PR pipeline cannot substitute for those gates or authorize a release.
