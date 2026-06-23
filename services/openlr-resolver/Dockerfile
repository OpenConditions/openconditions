# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

# ghcr.io/openconditions/openlr-resolver
FROM python:3.12-slim AS base

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

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4200/health').status==200 else 1)"

CMD ["python", "-m", "app"]
