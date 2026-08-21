# Hermes Web — status projektu i plan

## ✅ Zrobione (zweryfikowane)

- **M0** — renderer desktopa działa w przeglądarce: `apps/web-desktop` (entry, web bridge z hermes-ui MIT, vite config, Tailwind `@source`, `.env`)
- **M1** — build produkcyjny (`pnpm build`, chunki + lazy shiki/mermaid)
- **M2** — model deploy: `deploy.sh` (nix build → kopiuj do `~/.hermes/desktop-web` → health-check `HERMES_WEB_URL`), bez zarządzania procesami; `HERMES_WEB_DIST` wskazuje katalog builda (ustawiane raz w nix-config dashboardu)
- **Flake** — `nix build .` buduje TYLKO web dist (input `hermes-agent` pinned w `flake.lock`, pnpm `--filter web-desktop`, `pnpmConfigHook`, offline); `nix develop` (node+pnpm+symlinki źródeł z inputa); `nix flake update hermes` = aktualizacja upstreamu
- **M3a (PWA)** — `vite-plugin-pwa`: `sw.js`, `manifest.webmanifest`, 338 entries precache, denylist `/api|/auth|/login`, ikony z hermes-ui; rejestracja tylko na HTTPS (Tailscale)
- **Tryb HUD (mini-czat)** — bridge `hud` API: `open` → przejście na `?win=hud` (natywny widok HudShell renderera), `close` → powrót; reszta API no-op; typecheck: exclude testów upstreamu, subpathy `@hermes/shared/*`, stuby `@/debug/*`
- Czysta struktura repo (tylko web code + flake) + commit `3cf442a`
- Serwowanie na 4174 (preview + same-origin proxy, auth działa)
- **Tailscale Serve / HTTPS** — zrobione (poza Hermesem): `hermes-web.emu-nessie.ts.net`

## ⏳ Zostało

1. **Push repo na GitHub** (obecnie tylko lokalnie) → VPS klonuje
2. **Deploy na VPS**: `git clone` → `nix build` → `apps/web-desktop/scripts/deploy.sh`
3. **Zmiana w nix-config dashboardu (raz):** `HERMES_WEB_DIST=/home/ubuntu/.hermes/desktop-web`
4. **`nix run .#` (runner flake'a)** — wymaga hermesa respektującego `HERMES_WEB_DIST` (świeża instalacja; nix 0.20.0 lokalnie ignoruje)
5. **systemd/autostart** serwowania (opcjonalne; teraz proces w tle)
6. **Tożsamość git** — placeholder "Hermes Mobile" do podmiany
7. **Test akceptacyjny**: czat na 4174 + PWA na HTTPS (dodać do ekranu głównego, offline)
8. **M3b — Capacitor** (plan poniżej)

## 📌 M3b — Capacitor (natywna apka Android) + floating overlay — plan na później

Cel: ten sam web dist jako apka natywna; serwer bez zmian (gateway jawnie ufa
originowi `capacitor://`, `CapacitorHttp` omija CORS/SameSite).
Wariant docelowy: **pływająca, przezroczysta bańka czatu (chat heads) nad innymi
apkami** — jak Messenger. iOS wykluczony polityką (brak nakładek).

### Faza 1 — baza Capacitor (~1 dzień)
1. Deps: `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`
2. `capacitor.config.ts`: `{ appId: 'dev.hermes.web', appName: 'Hermes', webDir: 'apps/web-desktop/dist' }`
3. Adapter w `web-bridge/` (~40 linii): gdy `window.Capacitor` → `api()` przez `CapacitorHttp.request()`; WS zostaje zwykły (origin `capacitor://` zaufany); gateway URL/token z localStorage (domyślnie VPS przez Tailscale)
4. Build: `npx cap add android` → `npx cap sync` → `gradle assembleDebug` → APK
5. Weryfikacja: APK na telefonie → logowanie (token) → czat

### Faza 2 — floating overlay / chat heads (~1–2 dni)
6. Android `Service` (foreground) tworzący okno `TYPE_APPLICATION_OVERLAY` z **przezroczystym tłem**
7. WebView w overlay ładujący ten sam dist z `?win=hud` (nasz tryb HUD)
8. UI bańki: mała ikona → tap rozszerza do widoku HUD → collapse
9. Uprawnienie: `SYSTEM_ALERT_WINDOW` (Settings → overlay; prompt przy starcie)
10. Start/stop service z przycisku w apce; Android API 23+
11. Auth w overlay: token przekazany z głównej apki (współdzielony storage / Intent) — osobne localStorage WebView
12. Wymagany Android SDK/Gradle na maszynie buildowej (+~1–2 GB SDK, jeśli nie ma)

### Faza 3 — testy (~0.5–1 dzień)
13. APK na fizycznym Androidzie: czat w apce, bubble nad innymi apkami, przezroczystość, przełączanie sesji
14. Edge: odmowa uprawnienia, różne wersje Androida, notch/gesture, powiadomienia

### Utrzymanie (po wdrożeniu)
- Aktualizacje Capacitora/SDK przy kolejnych wersjach Androida
- Dystrybucja: sideload APK (bez Play Store) — użytkownik osobisty

### Warunki wstępne
- M3b startuje po: push repo na GitHub; **najpierw test PWA na telefonie** (jeśli PWA wystarczy — overlay może być zbędny)
- Android SDK/Gradle dostępne na maszynie buildowej (lub docker image z SDK)

## 📌 Desktop plugins w web — plan na później (~1–2h)

Cel: plugin'y desktopowe (`~/.hermes/desktop-plugins/<nazwa>/plugin.js` oraz
`~/.hermes/plugins/<nazwa>/desktop/plugin.js`) ładowane w Hermes Web.

Mechanizm (potwierdzony w kodzie): loader (runtime-loader.ts) pobiera rooty z
bridge (`desktopPluginsRoot`/`agentPluginsRoot`), czyta `plugin.js` przez
`readFileText` i wykonuje przez **blob `import()`** — działa natywnie w
przeglądarce; `watchDirectory` ma fallback poll 5s. Gateway **nie serwuje**
katalogów pluginów — trzeba je serwować samemu.

### Zakres (tylko nasze pliki)
1. **Middleware w `vite.config.ts`** (wzorzec jak emojibase):
   - `/desktop-plugins` → statyka z `$HERMES_HOME/desktop-plugins`
   - `/plugins` → statyka z `$HERMES_HOME/plugins`
   - JSON listing dla `readDir`
2. **Bridge** (~60–80 linii):
   - `desktopPluginsRoot`/`agentPluginsRoot` → URL same-origin (`/desktop-plugins`, `/plugins`)
   - `readFileText` → `fetch()` dla ścieżek pluginów (reszta: "unavailable")
   - `readDir` → fetch listingu
   - `watchDirectory` → zostaje stub (fallback poll 5s w loaderze)
3. **Prod (gateway-served, VPS):** reguła reverse-proxy (nginx/caddy) na ścieżki pluginów — config, bez zmian w upstreamie

### Uwagi
- Middleware bez auth (jak emojibase) — pliki pluginów widoczne z URL; opcjonalnie gating tokenem później
- Bezpieczeństwo jak w desktopie: plugin = pełne możliwości; tylko zaufane


