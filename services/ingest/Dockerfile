# Placeholder — a proper multi-stage build with published @openconditions/* packages and a
# pinned distroless runtime image is deferred to the release/image-build task.
FROM node:24-alpine AS base
WORKDIR /app

RUN npm install -g pnpm@11

FROM base AS build
COPY package.json ./
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app

RUN npm install -g pnpm@11

COPY package.json ./
RUN pnpm add --prod fastify postgres croner

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
