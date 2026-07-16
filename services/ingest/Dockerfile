# syntax=docker/dockerfile:1.7
#
# OpenConditions ingest service image.
#
# IMPORTANT: the build context MUST be the repo root — this Dockerfile reaches
# outside its own directory for the workspace manifests + lockfile and the
# @openconditions/* source it bundles. Build from the repo root:
#
#   docker build -t openconditions-ingest -f services/ingest/Dockerfile .
#
# The release workflow (.github/workflows/release.yml) builds it with `context: .`
# for the same reason.
#
# Runtime is a single esbuild bundle: tsup inlines @openconditions/* + drizzle-orm
# (see services/ingest/tsup.config.ts) and copies the migrations to dist/drizzle,
# so only fastify, postgres and croner remain as external runtime dependencies.

FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
# Read the pnpm version from the repo root package.json so lockfile resolution
# stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate
ENV HUSKY=0

# Production runtime dependencies only (fastify, postgres, croner — everything
# else is bundled into dist).
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/normalize/package.json packages/normalize/
COPY services/ingest/package.json services/ingest/
RUN pnpm install --filter @openconditions/ingest... --frozen-lockfile --prod --ignore-scripts

# Build the bundle (needs dev deps + the workspace package sources, which tsup
# resolves through each package's built dist — turbo builds them in order).
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/normalize/package.json packages/normalize/
COPY services/ingest/package.json services/ingest/
RUN pnpm install --filter @openconditions/ingest... --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json turbo.json ./
COPY packages/core/ packages/core/
COPY packages/ingest-framework/ packages/ingest-framework/
COPY packages/roads/ packages/roads/
COPY packages/publishers/ packages/publishers/
COPY packages/openlr/ packages/openlr/
COPY packages/normalize/ packages/normalize/
COPY services/ingest/ services/ingest/
# `...` builds the ingest's workspace dependencies first (topological), so tsup
# can inline their freshly built dist into the bundle.
RUN pnpm --filter @openconditions/ingest... build

# osmium-tool, built from source — it is not packaged for Alpine (see
# docs/plans/conditions/pbf-extract-source-design.md §3.1). Multi-stage so only
# the tiny binary + its shared libs reach the runtime image. Pinned to git tags;
# bump on a base-image change. Validated to build + run on musl (osmium 1.19.0).
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS osmium-build
RUN apk add --no-cache cmake make g++ git boost-dev expat-dev bzip2-dev zlib-dev lz4-dev nlohmann-json
RUN git clone --depth 1 -b v1.8.2 https://github.com/mapbox/protozero /src/protozero \
 && git clone --depth 1 -b v2.23.1 https://github.com/osmcode/libosmium /src/libosmium \
 && git clone --depth 1 -b v1.19.0 https://github.com/osmcode/osmium-tool /src/osmium-tool
RUN cmake -S /src/osmium-tool -B /build -DCMAKE_BUILD_TYPE=Release \
      -DOSMIUM_INCLUDE_DIR=/src/libosmium/include \
      -DPROTOZERO_INCLUDE_DIR=/src/protozero/include \
 && cmake --build /build -j"$(nproc)"

# Production image.
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runner
WORKDIR /app

# curl backs the http healthcheck; the OpenMapX compose renderer falls back to
# busybox wget, but curl keeps a plain `docker run` healthcheck working too. The
# rest are osmium's runtime shared libs (boost::program_options is NOT
# header-only; the lib is `libbz2`, not the `bzip2` CLI).
RUN apk add --no-cache curl libstdc++ expat libbz2 zlib lz4-libs boost-program_options

# The PBF-extract OSM source (pbfExtractSource) shells out to osmium; smoke-check
# the binary at build time so a broken/incompatible build fails CI, not prod.
COPY --from=osmium-build /build/src/osmium /usr/local/bin/osmium
RUN osmium --version

ENV NODE_ENV=production
ENV PORT=4100
ENV HOST=0.0.0.0
# Bounds the V8 heap. The NDW flow feed (enabled by default) processes ~18k
# per-sensor flows plus per-flow sample-writing/enrichment every cycle on top of
# the streamed ~373 MB site table, which needs well over 512 MB of heap; sized
# to run under the service memory limit below. Operators can override via env.
ENV NODE_OPTIONS="--max-old-space-size=1536 --heapsnapshot-signal=SIGUSR2"

# Runtime externals (fastify, postgres, croner) resolved from the workspace
# node_modules; everything else is inlined in dist.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/ingest/node_modules ./services/ingest/node_modules
COPY --from=builder /app/services/ingest/dist ./services/ingest/dist
COPY services/ingest/package.json ./services/ingest/

# Run as a dedicated non-root user. The service only reads its own bundle and
# talks to PostGIS over the network — it writes nothing to the filesystem.
RUN addgroup --system --gid 1001 ingest \
    && adduser --system --uid 1001 --ingroup ingest ingest \
    && chown -R ingest:ingest /app
USER ingest:ingest

WORKDIR /app/services/ingest
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/status" -o /dev/null || exit 1

LABEL org.opencontainers.image.title="OpenConditions ingest" \
      org.opencontainers.image.description="Fetch → parse → atomic PostGIS swap for road-condition observations." \
      org.opencontainers.image.source="https://github.com/openconditions/openconditions" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

CMD ["node", "dist/index.js"]
