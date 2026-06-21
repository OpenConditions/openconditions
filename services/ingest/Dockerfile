FROM node:24-alpine AS base
WORKDIR /app

RUN npm install -g pnpm@11

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
