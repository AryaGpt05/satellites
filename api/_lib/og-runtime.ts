/**
 * Load @vercel/og on a plain Node.js ESM runtime.
 *
 * @vercel/og 1.0.3's node build bundles satori 0.33, whose HarfBuzz text shaper is an emscripten
 * CJS module: at import time it calls `require('fs')` and locates `hb.wasm` from `__dirname`.
 * Neither exists in ESM, and `hb.wasm` isn't shipped in @vercel/og's dist, so a bare
 * `import '@vercel/og'` throws "Dynamic require of fs is not supported" outside a bundler.
 *
 * We provide exactly those two globals while the module evaluates (HarfBuzz captures both
 * synchronously), pointing `__dirname` at the installed `harfbuzzjs` package that carries
 * `hb.wasm`, then remove them again. vercel.json also ships that wasm with the function.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

type OgModule = typeof import('@vercel/og')

let loading: Promise<OgModule> | null = null

/** Directory holding hb.wasm. Falls back to the hoisted path vercel.json ships (includeFiles). */
function harfbuzzDir(req: NodeJS.Require): string {
  try {
    return path.dirname(req.resolve('harfbuzzjs/hb.wasm'))
  } catch {
    return path.join(process.cwd(), 'node_modules', 'harfbuzzjs')
  }
}

export function loadOg(): Promise<OgModule> {
  loading ??= (async () => {
    const g = globalThis as { require?: unknown; __dirname?: unknown }
    const setRequire = typeof g.require === 'undefined'
    const setDirname = typeof g.__dirname === 'undefined'
    const req = createRequire(import.meta.url)
    if (setRequire) g.require = req
    if (setDirname) g.__dirname = harfbuzzDir(req)
    try {
      return await import('@vercel/og')
    } finally {
      if (setRequire) delete g.require
      if (setDirname) delete g.__dirname
    }
  })().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}
