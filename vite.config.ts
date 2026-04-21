import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

/**
 * Serve `/ort/*.mjs` and `/vad/*.js` as-is.
 *
 * ONNX Runtime Web ships its WASM loaders as `.mjs` files that are pulled in
 * via a runtime `dynamicImport()` at a URL we configure (`/ort/`). When those
 * files live under `public/`, Vite's transform middleware intercepts the
 * `?import` request and returns a 500 ("This file is in /public and will be
 * copied as-is during build without going through the plugin transforms,
 * and therefore should not be imported from source code."). This middleware
 * hands the raw bytes back before Vite's transform layer sees the request.
 *
 * Production builds are unaffected — Vite copies `public/` to `dist/` as-is,
 * and the same-origin dynamic import works out of the box against the
 * static server.
 */
function rawPublicAssets(): Plugin {
  const publicDir = resolve(__dirname, 'public')
  const prefixes = ['/ort/', '/vad/']
  const mime: Record<string, string> = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream',
  }

  return {
    name: 'ai-companion:raw-public-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!prefixes.some((p) => url.startsWith(p))) return next()
        const pathname = url.split('?')[0]
        const filePath = join(publicDir, pathname)
        try {
          const stat = statSync(filePath)
          if (!stat.isFile()) return next()
        } catch {
          return next()
        }
        const ext = '.' + filePath.split('.').pop()
        res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(readFileSync(filePath))
      })
    },
  }
}

export default defineConfig({
  plugins: [rawPublicAssets(), react(), tailwindcss()],
  // wlipsync uses top-level `await` in its WASM bootstrap; bump targets past
  // Vite's default `es2020` so esbuild accepts it.
  build: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
