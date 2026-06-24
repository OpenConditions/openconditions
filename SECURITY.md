# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in OpenConditions, please report it privately.

**Do not open a public issue.** Public issues are read by everyone, and a
vulnerability report becomes a free attack guide before a fix is shipped.

Use one of:

1. **GitHub Security Advisory** (preferred) — open a draft advisory at
   <https://github.com/openconditions/openconditions/security/advisories/new>.
   This keeps the report private and lets us collaborate on a fix and a
   coordinated disclosure in one place.
2. **Email** — write to **security@openconditions.org**. If you wish to encrypt
   your report, ask for our PGP key in your first message.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected component (`services/ingest`, `services/openlr-resolver`, a
  specific `@openconditions/*` package, or the provider integration) and the
  version / commit SHA.
- Whether the issue requires a specific feed to be configured, the public
  emitter feeds to be reachable, or a particular deployment topology.

## Our commitment

- **Acknowledgement** within **3 business days** of your report.
- **Triage and an initial assessment** (including severity and a fix plan)
  within **10 business days**.
- We will keep you informed of progress, credit you in the advisory and release
  notes (unless you prefer to remain anonymous), and coordinate the public
  disclosure date with you.
- Our target is to ship a fix within **90 days** of triage; complex issues may
  take longer, and we will say so.

If you have not received an acknowledgement within 6 business days, please send a
brief follow-up in case the original report was missed.

## Supported versions

OpenConditions is pre-1.0. Only the latest commit on `main` and the most recent
tagged release receive security fixes. Older releases are not patched.

## Scope

In scope:

- `services/ingest` — the Fastify ingest service, including the public,
  rate-limited emitter feeds (`/observations.geojson`, `/traff.xml`,
  `/datex2/situations.xml`, `/gtfs-rt/alerts.pb`, `/valhalla/exclusions.json`,
  `/stream`, …).
- `services/openlr-resolver` — the Python OpenLR map-matcher.
- The published `@openconditions/*` packages (`core`, `roads`, `publishers`,
  `openlr`).
- The `road-conditions-openconditions` provider integration and the
  `openconditions-ingest` service manifest / Dockerfiles / default deployment
  configuration.

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
  `RATE_LIMIT_WINDOW_MS`); tune them for your traffic. Set `TRUST_PROXY_HOPS` to
  match the number of reverse proxies in front of the service so per-client IP
  limiting is accurate — never trust an arbitrary `X-Forwarded-For`.
- Terminate TLS at your reverse proxy.
- Subscribe to the repository's "Releases only" notifications so security
  releases reach you.

Thanks for helping keep OpenConditions and its users safe.
