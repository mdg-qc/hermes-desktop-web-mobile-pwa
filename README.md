> ⚠️ **Unofficial** — not affiliated with, endorsed by, or a part of the official
> `NousResearch/hermes-agent` repository. **The code is AI‑generated** (by the
> Hermes agent on DeepSeek V4 Flash) and reviewed **only by AI** — use at your
> own risk.

# Hermes Desktop — Web / Mobile (PWA) Version

The Hermes Desktop chat UI, repackaged as a web app and installable PWA, plus a
Docker image. At build time the renderer is pulled from the latest
`hermes-agent`.

## Provenance & intended use

- **AI‑generated.** Every line in this repo was written by the Hermes agent
  (running on DeepSeek V4 Flash) and reviewed only by that same AI. No human
  has looked at the code.
- **Private network only.** Built for Tailscale / tailnet. It has not been
  hardened for public HTTPS, so don't put it on the open internet as is.
- **Personal use.** The current state is enough for private, self‑hosted use.

The repo holds only the web code (`apps/web-desktop`) plus a nix flake. The
hermes-agent renderer is fetched by nix from `flake.lock` at build/dev time:
no clone, no `git pull`, and updating upstream is one command.

## Structure

```
flake.nix              build ONLY the web UI (hermes-agent = flake=false input)
pnpm-workspace.yaml    pnpm 11 workspace (only apps/web-desktop)
pnpm-lock.yaml         web dependency closure lockfile
package.json           root convenience scripts (pnpm-based)
.env / .env.example    HERMES_WEB_URL + WEB_ALLOWED_HOSTS
apps/web-desktop/      all our web code (entry, bridge, vite config, css…)
apps/web-desktop/scripts/deploy.sh   build → copy to ~/.hermes/desktop-web → health-check
```

## Quick start (dev)

```bash
nix develop                       # node+pnpm; symlinks renderer sources from the input
pnpm install                      # web closure only (no electron!)
pnpm --filter web-desktop run dev # http://<host>:5174/ (HMR)
```

## Build & deploy

```bash
nix build .#                      # → result/ = the web dist, nothing else
apps/web-desktop/scripts/deploy.sh  # nix build → copy → health-check
```

The deploy **manages no processes**: the nix-managed hermes dashboard serves
the dist via `HERMES_WEB_DIST` — configured **once** in the nix service to
`~/.hermes/desktop-web` (deploy's default target). After a deploy the dashboard
serves the new files immediately (static files, same path).

**Updating upstream:** `nix flake update hermes` (pins a new commit; rebuild
after). No repo management.

## .env

```bash
cp apps/web-desktop/.env.example apps/web-desktop/.env
```

- `HERMES_WEB_URL` — the URL you open from browser/phone; used by deploy.sh
  (health-check + printout).
- `WEB_ALLOWED_HOSTS` — comma-separated hostnames appended to Vite's
  `server.allowedHosts` (read by `vite.config.ts` via `loadEnv`), so Vite does
  not block access from e.g. Tailscale names.

## How the web build works

1. `src/entry.ts` installs `window.hermesDesktop` (web bridge, ported from
   [hermes-ui](https://github.com/przbadu/hermes-ui), MIT), loads `web.css`,
   then imports the live renderer `apps/desktop/src/main` (sources come from
   the flake input at `apps/desktop/src` + `apps/shared/src`).
2. The bridge flips the renderer's existing **remote-gateway mode**: REST via
   `api()`, WebSocket via `getGatewayWsUrl()`. Electron-only features are inert
   stubs (terminal, git, pet, updates, file dialogs…).
3. `src/web.css` declares `@source "../../desktop/src"` so Tailwind v4 scans
   the renderer sources for utility class names (otherwise the layout breaks).

## Editing the UI — only our files, never upstream

1. **CSS** — `src/web-overrides.css` (import in `entry.ts`), target
   `[data-slot=…]` selectors.
2. **Bridge behavior** — `src/web-bridge/`.
3. **Swap/wrap components** — add `resolve.alias` entries in `vite.config.ts`
   pointing upstream module paths at `src/overrides/<name>.tsx` (copy or
   re-export-with-changes; the original stays untouched).
4. **New code** — `src/components/`, `src/lib/` wired via entry.ts or overrides.

Never edit anything under `apps/desktop/` / `apps/shared/` (symlinked from the
input). After `nix flake update hermes`, re-check any aliased module paths.

## Nix flake notes

- First `nix build` fails on the **placeholder `pnpmDeps.hash`** — paste the
  real hash from the error into `flake.nix` and rebuild (one-time).
- `devShells.default` symlinks `apps/desktop` + `apps/shared` from the input
  only when they don't exist — never destroys a local clone's files.
- The flake source filter keeps only `apps/web-desktop` + root package files;
  everything else is supplied by the input.

## Desktop plugins

Hermes Agent **desktop plugins also work** in this web/PWA build. Built-in
plugins (e.g. **Bot Mode**) ship with the renderer; user plugins load from your
Hermes home (`~/.hermes/plugins`, `~/.hermes/desktop-plugins`) — in the Docker
image they are served straight from `HERMES_HOME`.

## Docker (frontend image)

A nix-free frontend image that needs nothing but `docker build`. There are no
build tools in the runtime. The build fetches the hermes-agent renderer
(`apps/desktop`, `apps/shared`) at `HERMES_RENDERER_REV` (default `main`, so the
latest upstream; pin a commit or tag for reproducible builds) and compiles it
with pnpm. The runtime is a lean `nginx` that serves the static dist and proxies
to a Hermes gateway.

```bash
# build (primary path — plain docker build, no nix)
docker build -t hermes-web .

# run — points at the config/gateway from .env; mount .env + hermes dir + host-gateway
docker run --rm --name hermes-web \
  -p 4174:80 \
  --add-host host.docker.internal:host-gateway \
  -v "$PWD/apps/web-desktop/.env:/app/.env:ro" \
  -v ~/.hermes:/data/hermes \
  hermes-web
```

Environment:
- `HERMES_GATEWAY_URL` — Hermes gateway backend (REST over `/api`,`/auth`,`/login`
  and WS over `/api/ws`), default `http://127.0.0.1:9119`.
- `HERMES_HOME` — path inside the container to the hermes config; its
  `plugins/` and `desktop-plugins/` dirs are served at `/plugins` and
  `/desktop-plugins` (mount e.g. `~/.hermes` there). Default `/data/hermes`.

Build args:
- `HERMES_RENDERER_REV` — renderer to bundle; default `main` = **always the
  latest upstream stream** on every build. Pin a commit/tag for reproducible/
  release builds: `docker build --build-arg HERMES_RENDERER_REV=<sha|tag> .`

> The nix **flake** (`flake.nix`) is a separate build path used on the VPS
> (home-manager / `nix build`); it **does not** build this image — the Docker
> image is built by `docker build` only. On the VPS the renderer pin is bumped
> automatically by the daily `hermes-flake-update` timer (`nix flake update
> hermes-mobile`), so the local deploy also tracks the latest upstream.

Publishing: `.github/workflows/docker-build.yml` builds `linux/amd64` +
`linux/arm64` on GitHub Actions and pushes `ghcr.io/<owner>/<repo>` on `main`
and `v*` tags. Build context is excluded of `.env`, `node_modules`, `dist`,
`apps/desktop`, `apps/shared` via `.dockerignore`.

## Git model

The repo is meant to be committed (a flake needs git-tracked sources), for
example under your own fork or a fresh repo. Upstream never writes to these
paths, so nothing conflicts.

## Changelog

### v0.1.1

Fixes from a security/correctness pass (still AI-reviewed only — see the
provenance note above):

- **Fixed: plugin listing was broken in the Docker/nginx build.**
  `nginx.conf.template` used to hardcode `/plugins/.listing` to always return
  `[]` and had no rule at all for `/desktop-plugins/.listing` (it fell through
  to a 404). In production this meant the "installed plugins" browser
  (`readDir()` in `src/web-bridge/bridge.ts`) always reported empty or errored,
  no matter what was actually mounted at `HERMES_HOME` — silently diverging
  from the `vite dev` middleware, which does a real listing. Both `.listing`
  endpoints now serve nginx's built-in `autoindex` (JSON format) to list the
  mounted directory live, at request time, matching dev behavior. (Because
  `autoindex` only answers URIs ending in `/`, each `.listing` endpoint
  302-redirects to the same path with a trailing slash, which is then served
  by `autoindex`.) `docker-entrypoint.sh` also `mkdir -p`s the two plugin
  directories on startup so a fresh/empty mount reports `[]` instead of
  404ing. Since both `.listing` endpoints now return richer `{name, type}` entries (nginx
  autoindex's native JSON shape) instead of bare name strings, the `vite dev`
  middleware (`vite.config.ts`) emits the same shape, and `readDir()` in
  `bridge.ts` parses it — keeping dev and production on one format.
- **Fixed: a path-prefix boundary bug in the plugin-root guard.** The web
  bridge's `readFileText`/`readDir` gated access with
  `filePath.startsWith(root)`, where `root` (e.g. `.../desktop-plugins`) has
  no trailing slash — so a sibling path like `.../desktop-pluginsSecret` would
  incorrectly pass as "under" the plugin root. Replaced with
  `isUnderPluginRoot()`, which requires an exact match or a `/` boundary.
