# syntax=docker/dockerfile:1.7
#
# OpenConditions contributions-api service image.
#
# IMPORTANT: the build context MUST be the repo root — this Dockerfile reaches
# outside its own directory for the workspace manifests + lockfile and the
# @openconditions/* source it bundles. Build from the repo root:
#
#   docker build -t openconditions-contributions-api -f services/contributions-api/Dockerfile .
#
# The release workflow (.github/workflows/release.yml) builds it with `context: .`
# for the same reason.
#
# Runtime is a single esbuild bundle: tsup inlines @openconditions/* + drizzle-orm
# (see services/contributions-api/tsup.config.ts) and copies the migrations to
# dist/drizzle, so only fastify, postgres and @cloudflare/privacypass-ts remain
# as external runtime dependencies.

FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
# Read the pnpm version from the repo root package.json so lockfile resolution
# stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate
ENV HUSKY=0

# Production runtime dependencies only (fastify, postgres, @cloudflare/privacypass-ts
# — everything else is bundled into dist).
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/contrib-core/package.json packages/contrib-core/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/normalize/package.json packages/normalize/
COPY services/ingest/package.json services/ingest/
COPY services/contributions-api/package.json services/contributions-api/
RUN pnpm install --filter @openconditions/contributions-api... --frozen-lockfile --prod --ignore-scripts

# Build the bundle (needs dev deps + the workspace package sources, which tsup
# resolves through each package's built dist — turbo builds them in order).
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/contrib-core/package.json packages/contrib-core/
COPY packages/ingest-framework/package.json packages/ingest-framework/
COPY packages/roads/package.json packages/roads/
COPY packages/publishers/package.json packages/publishers/
COPY packages/openlr/package.json packages/openlr/
COPY packages/normalize/package.json packages/normalize/
COPY services/ingest/package.json services/ingest/
COPY services/contributions-api/package.json services/contributions-api/
RUN pnpm install --filter @openconditions/contributions-api... --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json turbo.json ./
COPY packages/core/ packages/core/
COPY packages/contrib-core/ packages/contrib-core/
COPY packages/ingest-framework/ packages/ingest-framework/
COPY packages/roads/ packages/roads/
COPY packages/publishers/ packages/publishers/
COPY packages/openlr/ packages/openlr/
COPY packages/normalize/ packages/normalize/
COPY services/ingest/ services/ingest/
COPY services/contributions-api/ services/contributions-api/
# `...` builds the contributions-api's workspace dependencies first (topological),
# so tsup can inline their freshly built dist into the bundle.
RUN pnpm --filter @openconditions/contributions-api... build

# Production image.
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runner
WORKDIR /app

# curl backs the http healthcheck; the OpenMapX compose renderer falls back to
# busybox wget, but curl keeps a plain `docker run` healthcheck working too.
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=4200
ENV HOST=0.0.0.0

# Runtime externals (fastify, postgres, @cloudflare/privacypass-ts) resolved from
# the workspace node_modules; everything else is inlined in dist.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/contributions-api/node_modules ./services/contributions-api/node_modules
COPY --from=builder /app/services/contributions-api/dist ./services/contributions-api/dist
COPY services/contributions-api/package.json ./services/contributions-api/

# Run as a dedicated non-root user. The service only reads its own bundle and
# talks to PostGIS over the network — it writes nothing to the filesystem.
RUN addgroup --system --gid 1001 contrib \
    && adduser --system --uid 1001 --ingroup contrib contrib \
    && chown -R contrib:contrib /app
USER contrib:contrib

WORKDIR /app/services/contributions-api
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/status" -o /dev/null || exit 1

LABEL org.opencontainers.image.title="OpenConditions contributions-api" \
      org.opencontainers.image.description="Crowd-report ingest, evidence lifecycle, official-feed cross-validation and reviewer surface over the shared PostGIS conditions schema." \
      org.opencontainers.image.source="https://github.com/openconditions/openconditions" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

CMD ["node", "dist/main.js"]
