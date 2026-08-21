# web-desktop — Hermes chat UI in the browser

The **official Hermes Desktop renderer** (`apps/desktop/src`), built as a plain
Vite web app. It is the **chat** UI; the upstream **dashboard** (`hermes
dashboard`, `web/` workspace) stays as the **config** UI. Both talk to the same
Hermes backend.

This workspace is **additive**: it contains only new files under
`apps/web-desktop/`. No upstream file is modified, so `git pull` from
`NousResearch/hermes-agent` stays conflict-free.

## Layout

| File | Purpose |
|---|---|
| `src/entry.ts` | Bundle entry: installs the web bridge, loads `web.css`, then imports the live upstream renderer `apps/desktop/src/main` (no copy) |
| `src/web-bridge/` | Browser implementation of Electron's `window.hermesDesktop` (ported from [hermes-ui](https://github.com/przbadu/hermes-ui), MIT) — real `api()`/WS plumbing, inert stubs for Electron-only features |
| `src/web.css` | Tailwind v4 entry: `@source "../../desktop/src"` makes Tailwind scan the upstream renderer for utility class names (the compiler otherwise only sees this workspace and emits ~3 classes → broken layout), then imports the upstream `styles.css` untouched |
| `vite.config.ts` | Desktop build patterns (aliases, emojibase assets, chunking) + dev proxy (`/api`, `/auth`, `/login`, `/api/ws` → gateway) ported from hermes-ui |
| `index.html` | Own shell (`#root`), pre-paint background script, entry script |
| `scripts/deploy.sh` | One-shot VPS deploy: pull → install → build → serve |

## Quick start

```bash
# deps (hoisted from the root workspace — desktop's deps cover the renderer)
npm install --engine-strict=false            # from repo root

# dev (proxy defaults to HERMES_GATEWAY_URL or http://127.0.0.1:9119)
npm run dev --workspace apps/web-desktop     # http://<host>:5174/

# production build
npm run build --workspace apps/web-desktop   # dist/ (12s, ~30 MB chunks incl. lazy shiki/mermaid)

# typecheck
npm run typecheck --workspace apps/web-desktop
```

## How it works

1. `entry.ts` imports `web-bridge/install` **first** — it defines
   `window.hermesDesktop` before any renderer store touches it at
   module-evaluation time.
2. `entry.ts` imports `../../desktop/src/main` — the upstream renderer runs
   as-is. Its `@/…` imports resolve through our aliases (`@` →
   `apps/desktop/src`, `@hermes/shared` → `apps/shared/src`).
3. The bridge flips the renderer's existing **remote-gateway mode**
   (`getConnection()` → `mode: 'remote'`): REST via `api()`, WebSocket via
   `getGatewayWsUrl()`. No Electron code ever runs.
4. Auth: token (`?token=` URL param, persisted in localStorage,
   `X-Hermes-Session-Token` header) or OAuth (popup `/login`, same-origin via
   the dev proxy; cookie session).

## Deploy (VPS)

```bash
apps/web-desktop/scripts/deploy.sh
```

What it does: `git pull --ff-only` (auto-resolving the known
`package-lock.json` conflict), `npm ci`, build, then:

```bash
HERMES_WEB_DIST=<repo>/apps/web-desktop/dist \
  hermes dashboard --port 4174 --host 0.0.0.0 --skip-build --no-open
```

`mount_spa()` serves our dist **same-origin** (session token injection + cookie
auth work, no CORS issues). Ports: **9119 = dashboard (config)**, **4174 =
Hermes Web (chat)**. (The CLI command is named `hermes dashboard` because that
is the backend-with-UI mode — `hermes serve` is hardcoded headless; which UI it
serves is decided solely by `HERMES_WEB_DIST`.)

> ⚠ `HERMES_WEB_DIST` is honored by current `main` (`hermes_cli/main.py`); the
> nix-packaged 0.20.0 binary ignores it. Use a fresh install (pip/venv or main
> checkout) on the VPS.

## git pull safety

- All local code lives in `apps/web-desktop/` — upstream never writes there.
- Files are meant to stay **untracked** (or commit them to your own fork).
  Untracked files survive every `git pull`; they only conflict if upstream ever
  adds a file at the same path (name collision on `apps/web-desktop` — unlikely).
- The one mergeable file is the root `package-lock.json` (our workspace entry
  + `http-proxy-3`). `deploy.sh` auto-resolves that specific conflict
  (`checkout --theirs` + reinstall); any other conflict requires manual work.

## Known limitations (stubs in the bridge)

Local terminal, native git ops, pet overlay, quick-entry hotkey, auto-update,
marketplace themes, local file dialogs, OAuth-in-keychain, SSH config. The
renderer's consumers probe for these and self-disable, so the chat experience
is unaffected. Local file attach/preview and anything routed through
`desktop-fs`/`desktop-git` won't work in the browser.

## Credits

`src/web-bridge/` is ported from [przbadu/hermes-ui](https://github.com/przbadu/hermes-ui)
(MIT, © Nous Research) and adapted to the current `apps/desktop/src/global.d.ts`
interface. Everything else is upstream Hermes Agent code imported live.
