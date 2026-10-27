# Image contexts and release metadata

The image producers in `.github/workflows/release.yml` use these literal inputs:

| Image             | Build context              | Recipe                                  | Default ignore file                      |
| ----------------- | -------------------------- | --------------------------------------- | ---------------------------------------- |
| ingest            | repository root            | `services/ingest/Dockerfile`            | `.dockerignore`                          |
| contributions-api | repository root            | `services/contributions-api/Dockerfile` | `.dockerignore`                          |
| federation        | repository root            | `services/federation/Dockerfile`        | `.dockerignore`                          |
| openlr-resolver   | `services/openlr-resolver` | `services/openlr-resolver/Dockerfile`   | `services/openlr-resolver/.dockerignore` |

A `<recipe>.dockerignore`, if present, overrides the context-root ignore file. The ingest service's
adjacent `.dockerignore` does **not** control its repository-root build. Docker applies the actual
ignore patterns; the context checker does not implement another ignore parser.

The root ignore excludes `extension.json`, `services/*/service.json`, `docs/release-notes/`,
`advisor-plans/` and `plans/`. The descriptors configure the external host. Runtime code and bundle
builders do not read them. Credential descriptor generation is a separate repository check, not an
image build step. The Node recipes build bundles and copy production dependencies, bundles and
package manifests into their runners; migrations and ingest feeds travel inside those bundles.
The resolver copies its application/scripts and installed dependencies from its service-local context,
which is outside the release metadata paths.

These exclusions do not remove package manifests, lockfiles, source, migrations or feeds. Existing
license/notice handling is unchanged: the root ignore already excludes root `LICENSE`/`LICENSES`;
nested package licenses and notices and resolver-local licenses/notices remain context inputs. This
change does not establish complete image license/notice delivery; image qualification must verify it.

## Compare two committed sources

With Git, tar, Docker and Buildx installed and a local BuildKit daemon running:

```bash
node scripts/check-docker-contexts.mjs --image-source <40-character-SHA-A> --release-source <40-character-SHA-B>
```

The command validates the four producer context/recipe mappings, archives the exact Git commits,
and disables object replacement for every Git read, including custom replacement namespaces. It
checks archived bytes against Git blob identities and preserves Git executable modes. It rejects
symlinks, submodules, unsafe paths and archives altered by export attributes. Neither the working tree
nor the index is modified. Untracked files, local secrets and build scratch never enter these archived
contexts. Tracked secrets still require the repository's normal credential controls.

For each image and snapshot it uses an external `FROM scratch; COPY . /` Dockerfile with a
Dockerfile-specific ignore containing the **exact bytes** selected by that producer. The original
recipe remains unchanged inside its context. Each real BuildKit local export is inventoried by sorted
relative file path, content SHA-256 and permission mode, with a hash of that inventory and BuildKit
build identity in the JSON result. Nonzero tool exits, missing/malformed receipts, unexpected exported
files or modes and missing essential inputs fail. Temporary snapshots and exports are removed even
on failure. No image is loaded, tagged or pushed; the command supplies no registry credentials,
network build steps or publisher permissions. BuildKit may retain its ordinary local build cache.

Exit 0 means all four effective contexts match. Changed recipes, selected/default ignore rules or the
producer workflow fail before export, even if an ignore would otherwise hide them. Other differences
produce exit 1 and per-image changed paths. Unit process failure cases and required Docker integration
cases are in `scripts/__tests__/docker-contexts*.test.ts` and run in the existing test projects. No
Docker work is added to commit or push hooks.

## Release acceptance remains separate

Context equality is only a prerequisite for reusing an image. It permits no arbitrary changes to
excluded service configuration. A release validator must separately enforce exact allowed JSON
pointers and value bindings, reject duplicate keys, freeze every other descriptor field and verify
candidate digest/source/run/attempt/artifact identities. Environment, resources, secrets, networking,
readiness, identity and dependency changes need an ordinary source change and newly qualified images,
even when contexts compare equal.

Image-source commit A needs successful trusted-main image builds, native/runtime checks, scans, SBOM
and provenance for its supported platforms. Release-metadata commit B needs its own full protected-main
qualification after merge and the separate release contract. Image provenance must continue to name A;
a successful comparison does not claim the image was built from B. This unmerged context-separation
change alone qualifies neither trusted-main images nor a release, and activates no publisher.
