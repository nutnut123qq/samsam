# syntax=docker/dockerfile:1
# Web Next.js (output standalone). Context = gốc repo.
FROM node:22-bookworm-slim AS build
WORKDIR /app/ts
COPY ts/package.json ts/package-lock.json ./
COPY ts/packages/core/package.json packages/core/
COPY ts/apps/api/package.json apps/api/
COPY ts/apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund --workspace @samsam/web --include-workspace-root
COPY ts/tsconfig.base.json ./
COPY ts/apps/web apps/web
RUN npm run build -w @samsam/web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/ts/apps/web/.next/standalone ./
COPY --from=build /app/ts/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
