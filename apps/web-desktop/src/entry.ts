// MUST be the first import in this bundle: installs `window.hermesDesktop`
// (the browser bridge) before any renderer module runs. Several renderer
// stores touch the bridge at module-evaluation time (store/translucency,
// store/power, lib/clipboard), and ES module imports execute in order.
import './web-bridge/install'

// Our Tailwind v4 entry: scans apps/desktop/src for utility class names and
// imports the upstream stylesheet (see web.css for why this is needed).
import './web.css'

// PWA: register the service worker (no-op off HTTPS / in dev).
import { registerPwa } from './pwa/register'

registerPwa()

// The upstream desktop renderer, imported LIVE from apps/desktop/src — no
// copy is made, so `git pull` from upstream never conflicts with this file.
import '../../desktop/src/main'
