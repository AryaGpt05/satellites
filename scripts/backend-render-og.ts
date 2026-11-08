/**
 * Render share cards locally, without `vercel dev`: import the /api/og handler, call it with
 * Request objects and write the PNGs.
 *
 *   npx tsx scripts/backend-render-og.ts                    # all cases → scratch/backend/og-*.png
 *   npx tsx scripts/backend-render-og.ts --default          # also bake public/og-default.png
 *   npx tsx scripts/backend-render-og.ts --id <shareId>     # a stored share (needs .env.local)
 *   SITE_URL=https://example.org npx tsx …                  # print that host in the card footer
 *
 * The cases use real archive item ids and real SGP4 pass geometry for Waterloo, Ontario (from the
 * ui-results sandbox fixture). They are dev fixtures for this script only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'scratch', 'backend')

/** Load .env.local into process.env (the functions read it at request time). */
async function loadEnv(): Promise<void> {
  try {
    const txt = await readFile(path.join(ROOT, '.env.local'), 'utf8')
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {
    /* no env: id cases will fall back to the default card */
  }
}

const WATERLOO = { place: 'Waterloo', lat: '43.4723', lon: '-80.5449' }

const CASES: Record<string, Record<string, string>> = {
  'default': {},
  's2c-imaged': {
    ...WATERLOO,
    sat: 'Sentinel-2C', norad: '60989', verdict: 'imaged', t: '1793549661025', alt: '794.9', off: '5.26', cloud: '25.46',
    dist: '73.26', az: '103.9', hdg: '194.6', collection: 'sentinel-2-l2a', item: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  },
  'landsat9-imaged': {
    ...WATERLOO,
    sat: 'Landsat 9', norad: '49260', verdict: 'imaged', t: '1793462633109', alt: '708.3', off: '3.39', cloud: '11.68',
    dist: '41.97', az: '103.6', hdg: '194.1', collection: 'landsat-c2-l2', item: 'LC09_L2SP_018030_20261031_02_T1',
  },
  'aqua-modis-imaged': {
    ...WATERLOO,
    sat: 'Aqua', norad: '27424', verdict: 'imaged', t: '1793649253606', alt: '692.7', off: '48.38', dist: '845.15', az: '68.1',
    hdg: '345.3', collection: 'gibs-modis-aqua', item: 'MODIS_Aqua_CorrectedReflectance_TrueColor@2026-11-02',
  },
  'skysat-could': {
    ...WATERLOO,
    sat: 'SkySat-C3', norad: '41774', verdict: 'could', t: '1793625435556', alt: '397.1', off: '16.99', dist: '121.71', az: '283.1', hdg: '192.1',
  },
  'iss-overhead': {
    ...WATERLOO,
    sat: 'ISS (Zarya)', norad: '25544', verdict: 'overhead', t: '1793527773425', alt: '427.5', off: '0.87', dist: '6.47', az: '33.9', hdg: '122.9',
  },
  'metop-likely': {
    ...WATERLOO,
    sat: 'MetOp-B', norad: '38771', verdict: 'likely', t: '1793197950702', alt: '827.5', off: '20.96', dist: '320.3', az: '102', hdg: '194.6',
  },
  'long-place': {
    place: 'Saint-Jean-sur-Richelieu, Montérégie', lat: '45.3', lon: '-73.26',
    sat: 'Sentinel-2C', norad: '60989', verdict: 'could', t: '1793549661025', alt: '794.9', off: '5.26', dist: '18', az: '280', hdg: '194.6',
  },
  'bad-item': {
    ...WATERLOO,
    sat: 'Sentinel-2C', norad: '60989', verdict: 'imaged', t: '1793549661025', alt: '794.9', off: '5.26', cloud: '25',
    dist: '73', az: '103.9', hdg: '194.6', collection: 'sentinel-2-l2a', item: 'S2C_MSIL2A_20990101T000000_R140_T17TNJ_20990101T000000',
  },
}

async function main() {
  await loadEnv()
  // Imported through a variable: tsconfig.node.json has no `jsx` setting, and TypeScript refuses to
  // resolve a static import of a .tsx module without one (even though og.tsx contains no JSX).
  const ogModule = '../api/og.tsx'
  const { handleOg } = (await import(ogModule)) as { handleOg: (request: Request) => Promise<Response> }
  await mkdir(OUT, { recursive: true })
  const args = process.argv.slice(2)
  const idIdx = args.indexOf('--id')
  const jobs: [string, string][] =
    idIdx >= 0 ? [[`id-${args[idIdx + 1]}`, `id=${encodeURIComponent(args[idIdx + 1] ?? '')}`]] : Object.entries(CASES).map(([k, q]) => [k, new URLSearchParams(q).toString()])

  const origin = process.env.SITE_URL || 'http://localhost:5186'
  for (const [name, qs] of jobs) {
    const t0 = performance.now()
    // SITE_URL (if set) is what the card footer prints; otherwise a local origin, which the card hides.
    const res = await handleOg(new Request(`${origin}/api/og${qs ? `?${qs}` : ''}`))
    const buf = Buffer.from(await res.arrayBuffer())
    const file = path.join(OUT, `og-${name}.png`)
    await writeFile(file, buf)
    console.log(
      `${name.padEnd(20)} ${res.status} ${res.headers.get('content-type')} ${(buf.byteLength / 1024).toFixed(0).padStart(5)} KB ` +
        `${(performance.now() - t0).toFixed(0).padStart(6)} ms  cache: ${res.headers.get('cache-control')}  → ${path.relative(ROOT, file)}`,
    )
    if (name === 'default' && args.includes('--default')) {
      await writeFile(path.join(ROOT, 'public', 'og-default.png'), buf)
      console.log('  → public/og-default.png')
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
