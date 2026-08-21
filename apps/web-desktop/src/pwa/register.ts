// PWA service-worker registration (vite-plugin-pwa with injectRegister: null,
// so we register ourselves). Only registers on HTTPS (or localhost) — service
// workers are unavailable on plain http, which is why the Tailscale HTTPS URL
// (hermes-web.emu-nessie.ts.net) is the PWA entry point.
export function registerPwa(): void {
  if (!('serviceWorker' in navigator)) {
    return
  }

  const { hostname, protocol } = window.location
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')

  if (protocol !== 'https:' && !isLocalhost) {
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .catch(() => {
        // Best-effort: a failed registration (e.g. dev server) just means no
        // offline/install support — the app still works.
      })
  })
}
