# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in OpenConditions, please report it privately. **Do not open a public issue.**

1. **GitHub private vulnerability reporting (preferred)** — use [Report a vulnerability](https://github.com/OpenConditions/openconditions/security/advisories/new), also available from the repository's [Security page](https://github.com/OpenConditions/openconditions/security). Sign in to GitHub to submit a private report. Maintainers with advisory permissions use the same route to create a draft advisory.
2. **Email fallback** — write to **security@openconditions.org** if you cannot use GitHub. Mailbox monitoring and delivery have not been independently verified; GitHub reporting is preferred. If you wish to encrypt your report, ask for our PGP key in your first message.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof of concept tested only on your own deployment.
- The affected service, integration or `@openconditions/*` package and the version or commit SHA.
- Any feed configuration, public API exposure, authentication scope or deployment topology needed to reproduce the issue.

## Response and disclosure

Maintainers aim, on a best-effort basis, to acknowledge reports within **7 calendar days** and provide an initial triage assessment within **14 calendar days**. These are targets, not guaranteed response times or a promise to provide a fix by a fixed deadline.

We aim to keep you informed of progress and coordinate the public disclosure date with you. We will offer credit in the advisory and relevant release notes unless you prefer to remain anonymous. Timing depends on severity, affected versions and maintainer availability. If the acknowledgement target has passed, a brief follow-up through the private reporting channel is appropriate.

## Supported versions

OpenConditions is pre-1.0. Only the latest commit on `main` and the most recent
tagged release receive security fixes. Older releases are not patched.

## Scope

In scope:

- `services/ingest` and `services/ingest-heavy` — feed ingestion, scheduling, record APIs, streaming and public emitter projections.
- `services/contributions-api` — community submissions, moderation, contributor receipts and authentication/authorization boundaries.
- `services/federation` — peer exchange, registry trust and federation APIs.
- `services/openlr-resolver` — the Python OpenLR map-matcher and its service API.
- The `@openconditions/*` workspace packages, including parsers, publishers, model modules, persistence, cryptography and integrations. Inclusion here does not imply that a package has been publicly published.
- Service manifests, Dockerfiles and default deployment configuration maintained in this repository, including interactions with a host platform.

Out of scope (report upstream instead):

- Upstream services run alongside OpenConditions as Docker images (PostGIS, and,
  when self-hosting OpenMapX, Valhalla / Redis / …).
- The source-data feed providers and their APIs (NDW, Die Autobahn, Digitraffic,
  DriveBC, WZDx, …).
- The OpenMapX host platform itself — report those to OpenMapX. A vulnerability
  in how the OpenConditions integration or service interacts with the host _is_
  in scope here.
- Findings that require a misconfigured or out-of-date self-hosted deployment,
  physical access, or social engineering of a maintainer.

## Safe harbor

We consider security research conducted in good faith under this policy to be
authorized. We will not pursue or support legal action against anyone who:

- makes a good-faith effort to comply with this policy,
- avoids privacy violations, data destruction, and degradation of service to
  others (test only against your own deployment), and
- gives us a reasonable opportunity to fix an issue before disclosing it
  publicly.

If in doubt about whether an action is acceptable, ask us first via the channels
above.

## Self-hosted deployment hardening

If you self-host the OpenConditions ingest service, a few recommendations:

- Use a strong, unique database password; do not expose PostGIS to the public
  internet — the ingest service should reach it over a private network.
- The public emitter feeds are rate-limited (`RATE_LIMIT_MAX` /
  `RATE_LIMIT_WINDOW_MS`), and `/stream` refuses connections past
  `STREAM_MAX_CONNECTIONS` (default 100); tune them for your traffic. `TRUST_PROXY_CIDRS`
  controls which immediate reverse-proxy address ranges may supply the client
  IP. The default accepts local and container networks and only one proxy hop;
  use explicit CIDRs if your proxy is elsewhere.
- Terminate TLS at your reverse proxy.
- Subscribe to the repository's "Releases only" notifications so security
  releases reach you.

Thanks for helping keep OpenConditions and its users safe.
