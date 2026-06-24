# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

# ghcr.io/openconditions/openlr-resolver
#
# Map-matches OpenLR location references onto an OSM-derived road graph in
# PostGIS. Currently dormant — no open feed in the ingest carries OpenLR — so the
# service is published for completeness and activates when an OpenLR-bearing feed
# is configured. See README.md.
FROM python:3.14-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System libraries shapely/osmium link against (GEOS, expat, zlib).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgeos-c1v5 libexpat1 zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts

ENV HOST=0.0.0.0 \
    PORT=4200

# Run as a dedicated non-root user. The resolver only reads its own code and
# talks to PostGIS over the network — it writes nothing to the filesystem.
RUN useradd --system --uid 1001 --create-home --home-dir /home/resolver resolver \
    && chown -R resolver:resolver /app
USER resolver

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4200/health').status==200 else 1)"

LABEL org.opencontainers.image.title="OpenConditions OpenLR resolver" \
      org.opencontainers.image.description="Map-matches OpenLR location references onto an OSM road graph (dormant)." \
      org.opencontainers.image.source="https://github.com/openconditions/openconditions" \
      org.opencontainers.image.licenses="Apache-2.0"

CMD ["python", "-m", "app"]
