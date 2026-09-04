import { defineConfig, loadEnv, type Plugin, type PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createProxyServer, type ProxyServer } from 'http-proxy-3'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { VitePWA } from 'vite-plugin-pwa'

// The desktop renderer ships a Vite config with everything this build needs
// (monorepo aliases, emojibase assets, chunking); this config reuses those
// patterns but points the entry at apps/desktop/src/main via src/entry.ts.
// The dynamic gateway proxy below is ported from hermes-ui (MIT) so dev-mode
// /api, /auth, /login and /api/ws route to a configured gateway same-origin.

// `hgui` symlinks a worktree's node_modules to the main checkout; Vite realpaths
// those before enforcing server.fs.allow. Whitelist the real locations.
const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const fsAllow = [
  ...new Set(
    [
      path.resolve(__dirname, '..'),
      real(path.resolve(__dirname, 'node_modules')),
      real(path.resolve(__dirname, '../../node_modules'))
    ].filter((p): p is string => p !== null)
  )
]

// The dev-only render/state churn counters (apps/desktop/src/debug) must be
// imported STATICALLY above react-dom; alias the whole graph out of non-dev
// builds (same trick as apps/desktop/vite.config.ts).
const debugEntry = (command: string, env: Record<string, string>) =>
  command === 'serve' || env.VITE_PERF_PROBE === '1'
    ? path.resolve(__dirname, '../desktop/src/debug/dev-only.ts')
    : path.resolve(__dirname, '../desktop/src/debug/dev-only.noop.ts')

// The emoji picker fetches emojibase JSON at runtime; serve the bundled
// emojibase-data package at a stable local path (same as desktop).
const emojibaseDir =
  real(path.resolve(__dirname, 'node_modules/emojibase-data')) ??
  real(path.resolve(__dirname, '../../node_modules/emojibase-data'))

const EMOJIBASE_PATH = /^[a-z-]+\/(data|messages|shortcodes\/emojibase)\.json$/

const emojibaseAssets = () => ({
  name: 'hermes:emojibase-assets',
  configureServer(server: {
    middlewares: { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => void }
  }) {
    server.middlewares.use('/emojibase', (req, res, next) => {
      const rel = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
      if (!emojibaseDir || !EMOJIBASE_PATH.test(rel)) return next()
      fs.readFile(path.join(emojibaseDir, rel), (err: unknown, buf: Buffer) => {
        if (err) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.end(buf)
      })
    })
  },
  generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: Uint8Array }) => void }) {
    if (!emojibaseDir) return
    for (const rel of ['en/data.json', 'en/messages.json', 'en/shortcodes/emojibase.json']) {
      this.emitFile({
        type: 'asset',
        fileName: `emojibase/${rel}`,
        source: fs.readFileSync(path.join(emojibaseDir, rel))
      })
    }
  }
})

// The web bridge lists and loads installed desktop plugins at runtime from
// the Hermes home dir; serve both plugin roots over HTTP (dev + preview).
// HERMES_HOME overrides the default ~/.hermes location.
const hermesHome = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')

// Shared structural type for the dev AND preview middleware servers.
interface PluginsServerLike {
  middlewares: { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => void }
}

const hermesPluginsAssets = () => {
  const roots = [
    { prefix: '/desktop-plugins', dir: path.join(hermesHome, 'desktop-plugins') },
    { prefix: '/plugins', dir: path.join(hermesHome, 'plugins') }
  ]

  const attach = (server: PluginsServerLike): void => {
    for (const { prefix, dir } of roots) {
      server.middlewares.use(prefix, (req, res, next) => {
        const rel = (req.url ?? '').split('?')[0].replace(/^\/+/, '')

        if (rel === '.listing') {
          // Shape matches production: nginx.conf.template serves this same
          // endpoint via its built-in autoindex (JSON format), which emits
          // {name,type} objects rather than bare name strings — see the
          // `readDir` bridge code in web-bridge/bridge.ts.
          fs.readdir(dir, { withFileTypes: true }, (err: unknown, entries) => {
            if (err) {
              res.setHeader('Content-Type', 'application/json')
              res.end('[]')
              return
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify(
                entries.filter(e => e.isDirectory()).map(e => ({ name: e.name, type: 'directory' }))
              )
            )
          })
          return
        }

        const normalized = path.normalize(rel)

        if (!rel || normalized.startsWith('..') || path.isAbsolute(normalized)) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const file = path.join(dir, normalized)

        if (!file.startsWith(`${dir}${path.sep}`)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        fs.readFile(file, (err: unknown, buf: Buffer) => {
          if (err) {
            res.statusCode = 404
            res.end('not found')
            return
          }
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
          res.end(buf)
        })
      })
    }
  }

  return {
    name: 'hermes:plugins-assets',
    configureServer(server: PluginsServerLike) {
      attach(server)
    },
    configurePreviewServer(server: PluginsServerLike) {
      attach(server)
    }
  }
}

// --- Dynamic dev proxy (ported from hermes-ui, MIT) --------------------------
const GATEWAY = process.env.HERMES_GATEWAY_URL ?? 'http://127.0.0.1:9119'

// Optional repo-root config.json (git-ignored) whose `gateways` array whitelists
// additional gateway URLs for the dev proxy.
function readLocalConfig(): { gateways?: unknown } | null {
  const file = path.resolve(__dirname, '..', '..', 'config.json')

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[hermes] ignoring unreadable config.json: ${(error as Error).message}`)
    }

    return null
  }
}

function configGatewayUrls(config: { gateways?: unknown } | null): string[] {
  const raw = config?.gateways

  if (!Array.isArray(raw)) {return []}

  return raw
    .map(entry => (typeof entry === 'string' ? entry : (entry as { url?: unknown })?.url))
    .filter((url): url is string => typeof url === 'string' && url.trim() !== '')
    .map(url => url.trim())
}

function envGatewayUrls(): string[] {
  return (process.env.HERMES_GATEWAY_WHITELIST ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

const LOCAL_CONFIG = readLocalConfig()

const TARGETS = new Map<string, string>()

for (const url of [GATEWAY, ...configGatewayUrls(LOCAL_CONFIG), ...envGatewayUrls()]) {
  try {
    const origin = new URL(url).origin

    if (!TARGETS.has(origin)) {TARGETS.set(origin, url)}
  } catch {
    // skip non-absolute / unparseable entries
  }
}

const GATEWAY_WHITELIST = [...TARGETS.keys()]

const DEFAULT_TARGET = (() => {
  try {
    new URL(GATEWAY)

    return GATEWAY
  } catch {
    return 'http://127.0.0.1:9119'
  }
})()

const PROXY_PREFIXES = ['/api', '/auth', '/login']
const ROUTE_COOKIE = 'hermes_dev_gateway'
const ROUTE_PARAM = '__hgw'
const TARGET_ORIGIN = Symbol('hermesTargetOrigin')

function matchesPrefix(url: string | undefined): boolean {
  if (!url) {return false}

  return PROXY_PREFIXES.some(p => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {return undefined}

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')

    if (eq === -1) {continue}

    if (part.slice(0, eq).trim() === name) {return decodeURIComponent(part.slice(eq + 1).trim())}
  }

  return undefined
}

function validOrigin(raw: null | string | undefined): string | undefined {
  if (!raw) {return undefined}

  try {
    const origin = new URL(raw).origin

    return TARGETS.has(origin) ? origin : undefined
  } catch {
    return undefined
  }
}

function resolveOrigin(req: IncomingMessage): string {
  const parsed = req.url ? new URL(req.url, 'http://x') : null

  return (
    validOrigin(parsed?.searchParams.get(ROUTE_PARAM)) ??
    validOrigin(readCookie(req.headers.cookie, ROUTE_COOKIE)) ??
    new URL(DEFAULT_TARGET).origin
  )
}

function targetTag(origin: string): string {
  return crypto.createHash('sha256').update(origin).digest('hex').slice(0, 8)
}

function rewriteCookieHeader(header: string | undefined, tag: string): string | undefined {
  if (!header) {return undefined}

  const suffix = `__hg_${tag}`
  const kept: string[] = []

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')

    if (eq === -1) {continue}
    const name = part.slice(0, eq).trim()

    if (name === ROUTE_COOKIE) {continue}

    if (name.endsWith(suffix)) {kept.push(`${name.slice(0, -suffix.length)}=${part.slice(eq + 1).trim()}`)}
  }

  return kept.length ? kept.join('; ') : undefined
}

function namespaceSetCookie(cookie: string, tag: string): string {
  const segments = cookie.split(';')
  const first = segments[0]
  const eq = first.indexOf('=')

  if (eq === -1) {return cookie}
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1)
  const attrs = segments.slice(1).filter(s => !/^\s*domain=/i.test(s))

  return [`${name}__hg_${tag}=${value}`, ...attrs].join(';')
}

function stripRouteParam(req: IncomingMessage): void {
  if (!req.url || !req.url.includes(ROUTE_PARAM)) {return}
  const u = new URL(req.url, 'http://x')
  u.searchParams.delete(ROUTE_PARAM)
  req.url = u.pathname + u.search
}

// Shared wiring for the dev AND preview servers (preview serves the built
// dist — the production bundle — which still needs same-origin /api routing).
interface ProxyServerLike {
  middlewares: PreviewServer['middlewares']
  httpServer?: PreviewServer['httpServer'] | null
  config: PreviewServer['config']
}

function attachDynamicProxy(server: ProxyServerLike): void {
  const proxy: ProxyServer = createProxyServer({ changeOrigin: false, secure: false, ws: true })

  proxy.on('proxyRes', (proxyRes, req) => {
    const setCookie = proxyRes.headers['set-cookie']

    if (!setCookie) {return}
    const origin = (req as unknown as Record<symbol, string>)[TARGET_ORIGIN]

    if (!origin) {return}
    const tag = targetTag(origin)
    proxyRes.headers['set-cookie'] = setCookie.map(c => namespaceSetCookie(c, tag))
  })

  proxy.on('error', (err, _req, resOrSocket) => {
    server.config.logger.error(`[hermes-proxy] ${err.message}`, { timestamp: true })

    if (resOrSocket && 'writeHead' in resOrSocket) {
      const res = resOrSocket as ServerResponse

      if (!res.headersSent) {res.writeHead(502, { 'content-type': 'text/plain' })}
      res.end('gateway proxy error')
    } else if (resOrSocket) {
      ;(resOrSocket as Socket).destroy()
    }
  })

  const route = (req: IncomingMessage): string => {
    const origin = resolveOrigin(req)
    const cookie = rewriteCookieHeader(req.headers.cookie, targetTag(origin))

    if (cookie === undefined) {
      delete req.headers.cookie
    } else {
      req.headers.cookie = cookie
    }
    stripRouteParam(req)
    ;(req as unknown as Record<symbol, string>)[TARGET_ORIGIN] = origin

    return TARGETS.get(origin) ?? DEFAULT_TARGET
  }

  server.middlewares.use((req, res, next) => {
    if (!matchesPrefix(req.url)) {return next()}
    proxy.web(req, res, { target: route(req) })
  })

  server.httpServer?.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/api')) {return}
    proxy.ws(req, socket, head, { target: route(req) })
  })
}

function hermesDynamicProxy(): Plugin {
  // `env.command` is 'build' | 'serve'; `vite preview` reports 'serve' too.
  // Only the build must skip the whitelist injection (no proxy exists there).
  let command: 'build' | 'serve' = 'serve'

  return {
    name: 'hermes-dev-dynamic-proxy',
    config(_config, env) {
      command = env.command

      return {}
    },
    transformIndexHtml: () => {
      if (command === 'build') {return []}
      const inject = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')

      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `window.__HERMES_GATEWAY_WHITELIST__ = ${inject(GATEWAY_WHITELIST)};`
        }
      ]
    },
    configureServer(server) {
      attachDynamicProxy(server)
    },
    configurePreviewServer(server) {
      attachDynamicProxy(server)
    }
  }
}

export default defineConfig(({ command, mode }) => {
  // Extra hostnames allowed past Vite's Host check, from apps/web-desktop/.env
  // (WEB_ALLOWED_HOSTS, comma-separated) — e.g. Tailscale names, LAN hostnames.
  const env = loadEnv(mode, __dirname, '')
  const envAllowedHosts = (env.WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  return {
  base: './',
  plugins: [
    hermesDynamicProxy(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // We register the SW ourselves from src/pwa/register.ts.
      injectRegister: null,
      manifest: {
        name: 'Hermes',
        short_name: 'Hermes',
        description: 'A UI for the Hermes agent.',
        display: 'standalone',
        // Hash-routed SPA at the domain root.
        start_url: '.',
        scope: '.',
        background_color: '#111111',
        theme_color: '#0a0a0a',
        icons: [
          { src: 'hermes.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'hermes.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'hermes.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // Precache the whole app shell; the largest chunk (shiki) is ~19 MB,
        // so keep the per-file cap generous.
        globPatterns: ['**/*.{js,css,html,woff,woff2,ttf,otf,eot,png,jpg,jpeg,svg,gif,webp,ico}'],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Never hijack the gateway: /api (REST + WS upgrade), /auth, /login
        // must always hit the network.
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/login/]
      },
      devOptions: {
        // Keep the SW off in dev so it can't shadow the Vite proxy.
        enabled: false
      }
    }),
    emojibaseAssets(),
    hermesPluginsAssets()
  ],
  css: {
    postcss: { plugins: [] }
  },
  build: {
    chunkSizeWarningLimit: 25000,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            {
              name: 'vendor-md',
              test: /node_modules[\\/](property-information|hast-util-[^\\/]+|mdast-util-[^\\/]+|micromark[^\\/]*|unist-util-[^\\/]+|vfile[^\\/]*|unified|stringify-entities|space-separated-tokens|comma-separated-tokens|zwitch|html-void-elements|devlop|style-to-js|style-to-object|clsx)[\\/]/
            },
            {
              name: 'vendor-util',
              test: /node_modules[\\/](lodash-es|es-toolkit|uuid|dayjs|d3-array|d3-color|d3-force|d3-interpolate|d3-time[^\\/]*|dompurify|stylis)[\\/]/
            },
            {
              name: 'mermaid',
              test: /node_modules[\\/](mermaid|cytoscape|dagre|khroma|elkjs|d3|d3-[^\\/]+|@mermaid-js)[\\/]/
            },
            {
              name: 'shiki',
              test: /node_modules[\\/](shiki|@shikijs|react-shiki|@streamdown[\\/]code|oniguruma-to-es|oniguruma-parser|regex(-[^\\/]+)?)[\\/]/
            },
            { name: 'katex', test: /node_modules[\\/]katex[\\/]/ }
          ]
        }
      }
    }
  },
  resolve: {
    // The renderer sources are SYMLINKED from the pinned nix input in dev
    // (nix develop); realpathing them would make Vite look for node_modules
    // under the read-only store path and fail to resolve bare imports.
    preserveSymlinks: true,
    alias: [
      { find: '@/debug/dev-only', replacement: debugEntry(command, process.env as Record<string, string>) },
      { find: '@hermes/plugin-sdk', replacement: path.resolve(__dirname, '../desktop/src/sdk/index.ts') },
      { find: '@hermes/shared/billing', replacement: path.resolve(__dirname, '../shared/src/billing-types.ts') },
      { find: '@hermes/shared', replacement: path.resolve(__dirname, '../shared/src') },
      { find: '@', replacement: path.resolve(__dirname, '../desktop/src') },
      {
        find: 'react/jsx-dev-runtime',
        replacement: path.resolve(__dirname, '../../node_modules/react/jsx-dev-runtime.js')
      },
      {
        find: 'react/jsx-runtime',
        replacement: path.resolve(__dirname, '../../node_modules/react/jsx-runtime.js')
      },
      {
        find: 'react-dom',
        replacement: path.resolve(__dirname, '../../node_modules/react-dom')
      },
      {
        find: 'react',
        replacement: path.resolve(__dirname, '../../node_modules/react')
      },
      // driver.js's exports field doesn't expose the .iife subpath that
      // preview-tour.ts fetches (as ?raw) for the guest-page tour engine; alias
      // it straight to the on-disk file so the web build resolves it.
      {
        find: /^driver\.js\/dist\/driver\.js\.iife\.js(\?raw)?$/,
        // Keep the ?raw query ($1) so the file is imported as raw text (the
        // guest-page tour injects the IIFE payload), not parsed as a module.
        replacement:
          path.resolve(
            __dirname,
            '../../node_modules/driver.js/dist/driver.js.iife.js'
          ) + '$1'
      }
    ],
    dedupe: ['react', 'react-dom', 'react-router']
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: [...envAllowedHosts, 'prod-server', 'hermes-web.emu-nessie.ts.net', '.ts.net'],
    fs: {
      allow: fsAllow
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 4174
  }
  }
})
