# syntax=docker/dockerfile:1.7
#
# OpenConditions federation service image.
#
# IMPORTANT: the build context MUST be the repo root — this Dockerfile reaches
# outside its own directory for the workspace manifests + lockfile and the
# @openconditions/* source it bundles. Build from the repo root:
#
#   docker build -t openconditions-federation -f services/federation/Dockerfile .
#
# The release workflow (.github/workflows/release.yml) builds it with `context: .`
# for the same reason.
#
# Runtime is a single esbuild bundle: tsup inlines @openconditions/* + drizzle-orm
# (see services/federation/tsup.config.ts) and copies the migrations to
# dist/drizzle, so only fastify and postgres remain as external runtime
# dependencies.

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
# Read the pnpm version from the repo root package.json so lockfile resolution
# stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate
ENV HUSKY=0

# Production runtime dependencies only (fastify, postgres — everything else is
# bundled into dist).
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/contrib-core/package.json packages/contrib-core/
COPY packages/datex2/package.json packages/datex2/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/fuel/package.json packages/fuel/
COPY packages/parking/package.json packages/parking/
COPY packages/charging/package.json packages/charging/
COPY packages/cameras/package.json packages/cameras/
COPY packages/hazards/package.json packages/hazards/
COPY packages/weather/package.json packages/weather/
COPY packages/vehicles/package.json packages/vehicles/
COPY packages/border/package.json packages/border/
COPY packages/federation/package.json packages/federation/
COPY packages/storage/package.json packages/storage/
COPY packages/model/package.json packages/model/
COPY packages/model-border/package.json packages/model-border/
COPY packages/model-charging/package.json packages/model-charging/
COPY packages/model-facilities/package.json packages/model-facilities/
COPY packages/model-fuel/package.json packages/model-fuel/
COPY packages/model-hazards/package.json packages/model-hazards/
COPY packages/model-maritime/package.json packages/model-maritime/
COPY packages/model-parking/package.json packages/model-parking/
COPY packages/model-registry/package.json packages/model-registry/
COPY packages/model-roads/package.json packages/model-roads/
COPY packages/model-vehicles/package.json packages/model-vehicles/
COPY packages/model-weather/package.json packages/model-weather/
COPY services/ingest/package.json services/ingest/
COPY services/contributions-api/package.json services/contributions-api/
COPY services/federation/package.json services/federation/
RUN pnpm install --filter @openconditions/federation-api... --frozen-lockfile --prod --ignore-scripts

# Build the bundle (needs dev deps + the workspace package sources, which tsup
# resolves through each package's built dist — turbo builds them in order).
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches/ patches/
COPY packages/core/package.json packages/core/
COPY packages/contrib-core/package.json packages/contrib-core/
COPY packages/datex2/package.json packages/datex2/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/fuel/package.json packages/fuel/
COPY packages/parking/package.json packages/parking/
COPY packages/charging/package.json packages/charging/
COPY packages/cameras/package.json packages/cameras/
COPY packages/hazards/package.json packages/hazards/
COPY packages/weather/package.json packages/weather/
COPY packages/vehicles/package.json packages/vehicles/
COPY packages/border/package.json packages/border/
COPY packages/federation/package.json packages/federation/
COPY packages/storage/package.json packages/storage/
COPY packages/model/package.json packages/model/
COPY packages/model-border/package.json packages/model-border/
COPY packages/model-charging/package.json packages/model-charging/
COPY packages/model-facilities/package.json packages/model-facilities/
COPY packages/model-fuel/package.json packages/model-fuel/
COPY packages/model-hazards/package.json packages/model-hazards/
COPY packages/model-maritime/package.json packages/model-maritime/
COPY packages/model-parking/package.json packages/model-parking/
COPY packages/model-registry/package.json packages/model-registry/
COPY packages/model-roads/package.json packages/model-roads/
COPY packages/model-vehicles/package.json packages/model-vehicles/
COPY packages/model-weather/package.json packages/model-weather/
COPY services/ingest/package.json services/ingest/
COPY services/contributions-api/package.json services/contributions-api/
COPY services/federation/package.json services/federation/
RUN pnpm install --filter @openconditions/federation-api... --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json turbo.json ./
COPY packages/core/ packages/core/
COPY packages/contrib-core/ packages/contrib-core/
COPY packages/datex2/ packages/datex2/
COPY packages/ocpi/ packages/ocpi/
COPY packages/ingest-framework/ packages/ingest-framework/
COPY packages/roads/ packages/roads/
COPY packages/publishers/ packages/publishers/
COPY packages/openlr/ packages/openlr/
COPY packages/fuel/ packages/fuel/
COPY packages/parking/ packages/parking/
COPY packages/charging/ packages/charging/
COPY packages/cameras/ packages/cameras/
COPY packages/hazards/ packages/hazards/
COPY packages/weather/ packages/weather/
COPY packages/vehicles/ packages/vehicles/
COPY packages/border/ packages/border/
COPY packages/federation/ packages/federation/
COPY packages/storage/ packages/storage/
COPY packages/model/ packages/model/
COPY packages/model-border/ packages/model-border/
COPY packages/model-charging/ packages/model-charging/
COPY packages/model-facilities/ packages/model-facilities/
COPY packages/model-fuel/ packages/model-fuel/
COPY packages/model-hazards/ packages/model-hazards/
COPY packages/model-maritime/ packages/model-maritime/
COPY packages/model-parking/ packages/model-parking/
COPY packages/model-registry/ packages/model-registry/
COPY packages/model-roads/ packages/model-roads/
COPY packages/model-vehicles/ packages/model-vehicles/
COPY packages/model-weather/ packages/model-weather/
COPY services/ingest/ services/ingest/
COPY services/contributions-api/ services/contributions-api/
COPY services/federation/ services/federation/
# `...` builds the federation service's workspace dependencies first
# (topological), so tsup can inline their freshly built dist into the bundle.
RUN pnpm --filter @openconditions/federation-api... build

# Production image.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runner
WORKDIR /app

# Apply Alpine security fixes that landed after the immutable base was published.
# curl backs the healthcheck and tini reaps it. Package managers are build-time
# tools, so omit them from the production attack surface.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl tini \
    && rm -rf /usr/local/lib/node_modules/npm \
               /usr/local/lib/node_modules/corepack \
               /usr/local/bin/npm \
               /usr/local/bin/npx \
               /usr/local/bin/corepack \
               /opt/yarn-v1.22.22 \
               /usr/local/bin/yarn \
               /usr/local/bin/yarnpkg

ENV NODE_ENV=production
ENV PORT=4300
ENV HOST=0.0.0.0

# Runtime externals (fastify, postgres) resolved from the workspace
# node_modules; everything else is inlined in dist.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/federation/node_modules ./services/federation/node_modules
COPY --from=builder /app/services/federation/dist ./services/federation/dist
COPY services/federation/package.json ./services/federation/

# Run as a dedicated non-root user. The service only reads its own bundle and
# talks to PostGIS and its peers over the network — it writes nothing to the
# filesystem (its signing keys live in the database).
RUN addgroup --system --gid 1001 federation \
    && adduser --system --uid 1001 --ingroup federation federation \
    && chown -R federation:federation /app
USER federation:federation

WORKDIR /app/services/federation
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/status" -o /dev/null || exit 1

LABEL org.opencontainers.image.title="OpenConditions federation" \
      org.opencontainers.image.description="Instance-to-instance exchange of road and traffic conditions: actor document, signed peer outbox, subscriptions, inbox and backfill over the shared PostGIS conditions schema." \
      org.opencontainers.image.source="https://github.com/openconditions/openconditions" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

# Docker kills a healthcheck that times out but leaves its process for PID 1
# to reap, which node never does; tini as PID 1 reaps it and forwards signals.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
