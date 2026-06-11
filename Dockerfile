# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    npm_config_progress=false

FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --cache /root/.npm --prefer-offline

FROM deps AS build
COPY tsconfig.base.json vite.config.ts index.html ./
COPY client ./client
COPY server ./server
RUN npm run build
RUN npm prune --omit=dev

FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/configure-git-global.cjs ./scripts/configure-git-global.cjs
COPY scripts/docker-entrypoint.cjs ./scripts/docker-entrypoint.cjs
COPY data/app.config.json ./data/app.config.json
ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090
ENTRYPOINT ["node", "/app/scripts/docker-entrypoint.cjs"]
CMD ["node", "dist/server/index.js"]
