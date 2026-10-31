# syntax=docker/dockerfile:1
# API NestJS + worker BullMQ (cùng image; worker đổi command). Context = gốc repo.
# Node ≥ 22.13 (node:sqlite của webhook Zalo không cần cờ). trixie: có postgresql-client-17 (pg_dump
# cùng major DB 17 cho job backup/dr_drill) + openssl (mã hóa bản backup) — ops_scripts.
FROM node:22-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/ts
COPY ts/package.json ts/package-lock.json ./
COPY ts/packages/core/package.json packages/core/
COPY ts/apps/api/package.json apps/api/
COPY ts/apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @samsam/api
COPY ts/tsconfig.base.json ./
COPY ts/packages/core packages/core
COPY ts/apps/api apps/api
# data/*.json + docs/*.sql dùng chung với bản Python (compose mount data/ thật đè lên).
COPY data /app/data
COPY docs /app/docs
# Lịch worker BullMQ (34 job) — cùng tệp systemd dùng.
COPY deploy/onprem/jobs.json /app/deploy/onprem/jobs.json
# tsx đọc tsconfig từ cwd (/app/ts không có) — thiếu experimentalDecorators thì DI Nest hỏng.
ENV NODE_ENV=production TSX_TSCONFIG_PATH=apps/api/tsconfig.json
USER node
EXPOSE 3001
# tsx (esbuild) chạy thẳng TS — DI Nest dùng @Inject tường minh, không cần emitDecoratorMetadata.
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]
