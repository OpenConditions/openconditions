# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

# ghcr.io/openconditions/openlr-resolver
#
# Map-matches OpenLR location references onto an OSM-derived road graph in
# PostGIS. Currently dormant — no open feed in the ingest carries OpenLR — so the
# service is published for completeness and activates when an OpenLR-bearing feed
# is configured. See README.md.
FROM python:3.14.9-alpine3.24@sha256:dbeb11d16bb95c3a7e3c25c842cb9f20cbc8c18f8be0461a4a0dcc861ad386a0 AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# pyosmium has no musllinux wheel. Compile it in a disposable stage so compilers,
# source trees and build-system packages never reach the production image.
RUN apk upgrade --no-cache \
    && apk add --no-cache build-base cmake expat-dev zlib-dev bzip2-dev
COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --require-hashes -r requirements.txt
RUN rm -rf /opt/venv/bin/pip* \
              /opt/venv/lib/python3.14/site-packages/pip \
              /opt/venv/lib/python3.14/site-packages/pip-*.dist-info

FROM python:3.14.9-alpine3.24@sha256:dbeb11d16bb95c3a7e3c25c842cb9f20cbc8c18f8be0461a4a0dcc861ad386a0 AS runner

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH \
    HOST=0.0.0.0 \
    PORT=4200

WORKDIR /app

# Apply Alpine security fixes that landed after the immutable base was published.
# These are the shared libraries needed by the compiled pyosmium extension.
RUN apk upgrade --no-cache \
    && apk add --no-cache expat zlib libbz2 libstdc++ libgcc \
    && rm -rf /usr/local/bin/pip* \
              /usr/local/lib/python3.14/site-packages/pip \
              /usr/local/lib/python3.14/site-packages/pip-*.dist-info

COPY --from=builder /opt/venv /opt/venv

COPY app ./app
COPY scripts ./scripts

# Run as a dedicated non-root user. The resolver only reads its own code and
# talks to PostGIS over the network — it writes nothing to the filesystem.
RUN addgroup --system --gid 1001 resolver \
    && adduser --system --uid 1001 --ingroup resolver resolver \
    && chown -R resolver:resolver /app
USER resolver:resolver

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4200/health').status==200 else 1)"

LABEL org.opencontainers.image.title="OpenConditions OpenLR resolver" \
      org.opencontainers.image.description="Map-matches OpenLR location references onto an OSM road graph (dormant)." \
      org.opencontainers.image.source="https://github.com/openconditions/openconditions" \
      org.opencontainers.image.licenses="Apache-2.0"

CMD ["python", "-m", "app"]
