FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json vite.config.ts index.html ./
COPY client ./client
COPY server ./server
COPY data ./data
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache git
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
ENV PORT=8090
EXPOSE 8090
CMD ["node", "dist/server/index.js"]
