/**
 * The share page served at /s/:id: just enough HTML for link unfurlers (Open Graph + Twitter
 * card), then an immediate hand-off to the app at /?s=<id> for people.
 */

/** Escape for HTML text and double-quoted attribute values. */
export function esc(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** JSON for inline <script>: also neutralise `</script>`, `<!--` and line separators. */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export interface SharePageMeta {
  title: string
  description: string
  /** Absolute canonical URL of this page */
  canonical: string
  /** Absolute og:image URL */
  image: string
  imageAlt: string
  /** Where people are sent (same-origin path, e.g. "/?s=ab3d5f7h") */
  redirect: string
}

export function sharePageHtml(m: SharePageMeta): string {
  const t = esc(m.title)
  const d = esc(m.description)
  const href = esc(m.redirect)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${esc(m.canonical)}">
<meta name="theme-color" content="#07080A">
<meta name="robots" content="noindex, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Overflight">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${esc(m.canonical)}">
<meta property="og:image" content="${esc(m.image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(m.imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${esc(m.image)}">
<meta name="twitter:image:alt" content="${esc(m.imageAlt)}">
<meta http-equiv="refresh" content="0; url=${href}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
html,body{margin:0;height:100%;background:#07080A;color:#ECE8E0}
body{display:flex;align-items:center;justify-content:center;font:11px/1.5 ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
a{color:#FF6A1A;text-decoration:none}
</style>
</head>
<body>
<p>Opening <a href="${href}">Overflight</a></p>
<script>location.replace(${jsonForScript(m.redirect)})</script>
</body>
</html>
`
}
