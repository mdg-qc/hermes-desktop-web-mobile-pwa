# syntax=docker/dockerfile:1
#
# Hermes Web — frontend Docker image (chat UI).
#
# Build strategy: NIX-FREE, ALWAYS-LATEST by default. The hermes-agent renderer
# sources (apps/desktop, apps/shared) are NOT in the repo — they are fetched
# here directly from upstream at build time via a shallow git clone, then built
# with plain pnpm. No nix, no flake lockfile, no nix binary — a plain
# `docker build` anywhere.
#
# HERMES_RENDERER_REV defaults to `main` = toujours the latest upstream stream.
# Every `docker build` therefore bundles the freshest hermes-agent renderer.
# Reproducible/release builds can pin a commit or tag instead:
#   docker build --build-arg HERMES_RENDERER_REV=<sha|tag> .
#
# Runtime env:
#   HERMES_GATEWAY_URL  — hermes gateway backend (REST + WS), default http://127.0.0.1:9119
#   HERMES_HOME         — path to the hermes config/plugin roots served at
#                         /plugins and /desktop-plugins, default /data/hermes
#                         (mount e.g. ~/.hermes there).
#
# Builds as a normal `docker build` locally or on any CI (incl. GitHub Actions,
# .github/workflows/docker-build.yml) — builds linux/amd64 + linux/arm64.

# ---- build stage ----------------------------------------------------------------
FROM node:24-bookworm-slim AS build

# Renderer to bundle (NousResearch/hermes-agent, apps/desktop+apps/shared).
# default = `main` → build from the LATEST upstream stream on every build.
# Override with --build-arg HERMES_RENDERER_REV=<commit|tag> for a pin.
ARG HERMES_RENDERER_REV=main

# git (shallow clone of the pinned renderer).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) pnpm — pinned to the same major the lockfile expects (11).
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

# 2) Manifest + lockfiles first (cache-friendly layers).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web-desktop/package.json apps/web-desktop/package.json

# 3) Fetch the renderer sources at HERMES_RENDERER_REV and place them where the
#    vite aliases and tsconfig expect them (../desktop, ../shared).
RUN mkdir -p apps \
 && git init -q hermes-agent \
 && cd hermes-agent \
 && git remote add origin https://github.com/NousResearch/hermes-agent.git \
 && git fetch -q --depth 1 origin "$HERMES_RENDERER_REV" \
 && git config advice.detachedHead false && git checkout -q FETCH_HEAD \
 && cp -r apps/desktop /app/apps/desktop \
 && cp -r apps/shared /app/apps/shared \
 && cd /app && rm -rf hermes-agent

# 4) Install web closure (frozen lockfile) + build the dist.
COPY apps/web-desktop ./apps/web-desktop
RUN pnpm install --frozen-lockfile \
 && pnpm --filter web-desktop run build

# ---- runtime stage: nginx -------------------------------------------------------
FROM nginx:alpine

# The gateway URL + HERMES_HOME are injected by docker-entrypoint.sh via
# envsubst into the nginx template at container start.
COPY nginx.conf.template /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

COPY --from=build /app/apps/web-desktop/dist /usr/share/nginx/html

# Defaults — override with -e at runtime.
ENV HERMES_GATEWAY_URL=http://127.0.0.1:9119 \
    HERMES_HOME=/data/hermes

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]