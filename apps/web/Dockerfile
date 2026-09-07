# Harness Nexus — web SPA image.
#
# Multi-stage build:
#   - `build`    compiles the React + Vite SPA into static assets (apps/web/dist).
#   - `runtime`  nginx serves those assets AND reverse-proxies /api and /mcp to
#                the backend `server` service (see nginx.conf). No Node in the
#                runtime image.
#
# Build context is the repo root (so pnpm can resolve the workspace), invoked
# via `docker build -f apps/web/Dockerfile .` — see docker-compose.yml.

# ---- build stage ------------------------------------------------------------
FROM node:20-bookworm-slim AS build

# CN apt mirror (matches the server Dockerfile) — no proxy needed.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# corepack must see package.json's `packageManager` field to fetch the pinned
# pnpm version (9.12.0), not the latest (which may need a newer Node).
RUN corepack enable
WORKDIR /repo
COPY package.json ./
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN pnpm config set registry https://registry.npmmirror.com/

# Manifests + lockfile first → cacheable dependency layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json      packages/core/
COPY packages/shared/package.json    packages/shared/
COPY packages/sdk-ts/package.json    packages/sdk-ts/
COPY packages/server/package.json    packages/server/
COPY packages/mcp-runtime/package.json packages/mcp-runtime/
COPY packages/cli/package.json       packages/cli/
COPY apps/web/package.json           apps/web/
RUN pnpm install --frozen-lockfile

# Source. web's tsc composite references need core/shared/sdk dist/ first.
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @harness-nexus/core run build \
 && pnpm --filter @harness-nexus/shared run build \
 && pnpm --filter @harness-nexus/sdk run build \
 && pnpm --filter @harness-nexus/web run build

# ---- runtime stage ----------------------------------------------------------
FROM nginx:1.27-bookworm AS runtime

# Replace the stock config with our hardened reverse-proxy config.
COPY apps/web/nginx.conf /etc/nginx/nginx.conf

# Vite outputs to apps/web/dist/. Serve from nginx's default document root.
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

# nginx stays in the foreground via `daemon off` (set in nginx.conf).
