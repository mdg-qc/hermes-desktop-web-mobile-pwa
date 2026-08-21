# Hermes Mobile — Hermes Web (the chat UI in the browser)

The **official Hermes Desktop renderer** as a plain web app. It is the **chat**
UI; the upstream **dashboard** stays as the **config** UI. Both talk to the
same Hermes backend.

This repo contains **only the web code** (`apps/web-desktop`) plus a **nix
flake** — the hermes-agent renderer sources are fetched by nix (pinned in
`flake.lock`) at build/dev time. There is no clone, no `git pull`; updating
upstream is one command.

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

## Git model

This repo is meant to be committed (flake requires git-tracked files) — e.g.
your own fork or a fresh repo. Upstream never touches these paths, so nothing
here conflicts with anything.
