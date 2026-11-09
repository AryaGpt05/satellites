/**
 * The `?debug=gl` panel (see debugGl.ts): what the GPU and the globe's render pipeline are doing on THIS device, and
 * switches that turn each suspect of a rendering bug off (one reload each). Built for the owner's iPhone: big tap
 * targets, a "copy report" button whose text can be pasted straight into a message.
 *
 * Its own lazy chunk; never loaded without `?debug=gl`.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { activeGlSwitches, GL_SWITCHES, glProbe, urlWithSwitches } from './debugGl'

type Rows = [string, string][]

const fmt = (n: number | undefined, d = 0) => (n === undefined || Number.isNaN(n) ? '–' : n.toFixed(d))

/** Static facts about the context: asked once. */
function staticInfo(g: WebGL2RenderingContext): Rows {
  const rows: Rows = []
  const dbg = g.getExtension('WEBGL_debug_renderer_info')
  rows.push(['renderer', String(dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER))])
  rows.push(['vendor', String(dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR))])
  rows.push(['version', `${g.getParameter(g.VERSION)} / ${g.getParameter(g.SHADING_LANGUAGE_VERSION)}`])
  const pf = (shader: number, kind: number) => {
    const p = g.getShaderPrecisionFormat(shader, kind)
    return p ? `${p.precision}b ±2^${p.rangeMax}` : '–'
  }
  rows.push(['vs float hi/med', `${pf(g.VERTEX_SHADER, g.HIGH_FLOAT)} | ${pf(g.VERTEX_SHADER, g.MEDIUM_FLOAT)}`])
  rows.push(['fs float hi/med', `${pf(g.FRAGMENT_SHADER, g.HIGH_FLOAT)} | ${pf(g.FRAGMENT_SHADER, g.MEDIUM_FLOAT)}`])
  rows.push(['fs int hi/med', `${pf(g.FRAGMENT_SHADER, g.HIGH_INT)} | ${pf(g.FRAGMENT_SHADER, g.MEDIUM_INT)}`])
  rows.push(['max tex / rb / samples', `${g.getParameter(g.MAX_TEXTURE_SIZE)} / ${g.getParameter(g.MAX_RENDERBUFFER_SIZE)} / ${g.getParameter(g.MAX_SAMPLES)}`])
  rows.push(['max tex units fs/vs', `${g.getParameter(g.MAX_TEXTURE_IMAGE_UNITS)} / ${g.getParameter(g.MAX_VERTEX_TEXTURE_IMAGE_UNITS)}`])
  const attrs = g.getContextAttributes()
  rows.push(['ctx attrs', attrs ? `aa:${+!!attrs.antialias} depth:${+!!attrs.depth} alpha:${+!!attrs.alpha} pdb:${+!!attrs.preserveDrawingBuffer}` : '–'])
  const want = [
    'EXT_color_buffer_float',
    'EXT_color_buffer_half_float',
    'OES_texture_float_linear',
    'OES_texture_half_float_linear',
    'EXT_float_blend',
    'EXT_texture_filter_anisotropic',
    'KHR_parallel_shader_compile',
    'WEBGL_compressed_texture_astc',
    'EXT_clip_control',
    'EXT_depth_clamp',
  ]
  const have = new Set(g.getSupportedExtensions() ?? [])
  rows.push(['ext', want.map((e) => `${have.has(e) ? '+' : '−'}${e.replace(/^(EXT|OES|WEBGL|KHR)_/, '')}`).join(' ')])
  rows.push(['ext count', String(have.size)])
  return rows
}

/** Depth bits + colour type of a render target's framebuffer (the composer's input). */
function fbInfo(): string {
  const gl = glProbe.gl
  const c = glProbe.composer
  if (!gl || !c) return '–'
  const g = gl.getContext() as WebGL2RenderingContext
  const prev = gl.getRenderTarget()
  try {
    gl.setRenderTarget(c.inputBuffer)
    const att = (a: number, p: number) => g.getFramebufferAttachmentParameter(g.FRAMEBUFFER, a, p) as number
    const depthType = att(g.DEPTH_ATTACHMENT, g.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
    const depth = depthType === g.NONE ? 'none' : `${att(g.DEPTH_ATTACHMENT, g.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE)}b`
    const comp = att(g.COLOR_ATTACHMENT0, g.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE)
    const red = att(g.COLOR_ATTACHMENT0, g.FRAMEBUFFER_ATTACHMENT_RED_SIZE)
    const status = g.checkFramebufferStatus(g.FRAMEBUFFER)
    return `color ${comp === g.FLOAT ? 'float' : comp === g.UNSIGNED_NORMALIZED ? 'unorm' : `0x${comp.toString(16)}`}${red}b · depth ${depth} · ${status === g.FRAMEBUFFER_COMPLETE ? 'complete' : `status 0x${status.toString(16)}`}`
  } catch (e) {
    return String(e).slice(0, 60)
  } finally {
    gl.setRenderTarget(prev)
  }
}

function liveInfo(fps: number): Rows {
  const rows: Rows = []
  const gl = glProbe.gl
  const vv = window.visualViewport
  rows.push(['device DPR', fmt(window.devicePixelRatio, 2)])
  rows.push(['inner / vv', `${innerWidth}×${innerHeight} / ${vv ? `${fmt(vv.width)}×${fmt(vv.height)} top ${fmt(vv.offsetTop)} s${fmt(vv.scale, 2)}` : '–'}`])
  if (gl) {
    const g = gl.getContext() as WebGL2RenderingContext
    const el = gl.domElement
    rows.push(['canvas css', `${el.clientWidth}×${el.clientHeight}`])
    rows.push(['canvas attr / drawbuf', `${el.width}×${el.height} / ${g.drawingBufferWidth}×${g.drawingBufferHeight}`])
    rows.push(['gl pixelRatio', fmt(gl.getPixelRatio(), 2)])
    rows.push(['textures', `${el.dataset.textures ?? '–'} (day ${glProbe.rt?.textureLevel ?? '–'})`])
    rows.push(['ctx lost/restored', `${glProbe.contextLost}/${glProbe.contextRestored}${g.isContextLost() ? ' LOST NOW' : ''}`])
  }
  const c = glProbe.composer
  if (c) rows.push(['composer in', `${c.inputBuffer.width}×${c.inputBuffer.height} ms${c.multisampling} · ${fbInfo()}`])
  const cam = glProbe.camera as (typeof glProbe.camera & { near?: number; far?: number; fov?: number; aspect?: number }) | null
  if (cam) {
    const e = cam.projectionMatrix.elements
    rows.push(['near / far', `${fmt(cam.near, 4)} / ${fmt(cam.far)}`])
    rows.push(['fov / aspect', `${fmt(cam.fov, 1)} / ${fmt(cam.aspect, 3)}`])
    rows.push(['cam dist / shift', `${fmt(cam.position.length(), 3)} / ${fmt(-e[8], 3)}, ${fmt(-e[9], 3)}`])
  }
  const rt = glProbe.rt
  if (rt) rows.push(['loop', `${fmt(fps, 0)} fps · ${rt.throttled ? 'half-rate' : 'full'} · skip ${rt.skipRender} · ${rt.phase}`])
  const n = glProbe.nan
  rows.push(['NaN scan', `${n.scans} scans · last ${n.lastBad} px · max ${n.maxBad} · frames ${n.framesWithBad}${n.lastHuge ? ` · >64: ${n.lastHuge}` : ''}${n.error ? ` · ${n.error}` : ''}`])
  return rows
}

const PANEL: CSSProperties = {
  position: 'fixed',
  left: 'max(6px, env(safe-area-inset-left))',
  right: 'max(6px, env(safe-area-inset-right))',
  bottom: 'max(6px, env(safe-area-inset-bottom))',
  maxHeight: '48dvh',
  overflow: 'auto',
  zIndex: 2147483000,
  background: 'rgba(7, 8, 10, 0.88)',
  color: '#ece8e0',
  border: '1px solid rgba(236, 232, 224, 0.25)',
  font: '10px/1.45 ui-monospace, "Martian Mono", monospace',
  padding: 8,
  pointerEvents: 'auto',
  WebkitUserSelect: 'text',
  userSelect: 'text',
  touchAction: 'pan-y',
}
const BTN: CSSProperties = {
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(236, 232, 224, 0.35)',
  padding: '0 10px',
  minHeight: 36,
  marginRight: 6,
  marginBottom: 6,
}
const ON: CSSProperties = { ...BTN, background: '#ff6a1a', color: '#07080a', borderColor: '#ff6a1a' }

export default function DebugGl() {
  const [open, setOpen] = useState(true)
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState(false)
  const active = useMemo(() => new Set(activeGlSwitches()), [])

  // Poll the probe (cheap reads) twice a second; fps from the probe's frame counter.
  const [fps, setFps] = useState(0)
  useEffect(() => {
    let last = { t: performance.now(), f: glProbe.frames }
    const id = window.setInterval(() => {
      const now = performance.now()
      setFps(((glProbe.frames - last.f) * 1000) / Math.max(1, now - last.t))
      last = { t: now, f: glProbe.frames }
      setTick((t) => t + 1)
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  const gl = glProbe.gl
  const fixed = useMemo(() => (gl ? staticInfo(gl.getContext() as WebGL2RenderingContext) : null), [gl])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => liveInfo(fps), [tick, fps])

  const toggle = (id: string, group?: string) => {
    const next = new Set(active)
    if (next.has(id)) next.delete(id)
    else {
      if (group) for (const s of GL_SWITCHES) if (s.group === group) next.delete(s.id)
      next.add(id)
    }
    location.replace(urlWithSwitches(next))
  }

  const report = () =>
    [`watched ?debug=gl  ${new Date().toISOString()}`, navigator.userAgent, `switches: ${[...active].join(',') || 'none'}`, ...(fixed ?? []), ...live]
      .map((r) => (Array.isArray(r) ? `${r[0]}: ${r[1]}` : r))
      .join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this report', report())
    }
  }

  if (!open) {
    return createPortal(
      <button type="button" style={{ ...BTN, ...PANEL, right: 'auto', padding: '0 12px', minHeight: 44 }} onClick={() => setOpen(true)}>
        GL{active.size ? ` · ${active.size} off` : ''}
      </button>,
      document.body,
    )
  }

  const table = (rows: Rows) => (
    <div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8 }}>
          <span style={{ opacity: 0.6, flex: '0 0 auto', minWidth: 120 }}>{k}</span>
          <span style={{ wordBreak: 'break-word' }}>{v}</span>
        </div>
      ))}
    </div>
  )

  // Portalled to <body>: the app's sheets and panels form their own stacking contexts above the canvas.
  return createPortal(
    <div style={PANEL} role="dialog" aria-label="GL diagnostics">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ marginRight: 10, marginBottom: 6 }}>GL DEBUG</strong>
        <button type="button" style={BTN} onClick={copy}>
          {copied ? 'copied' : 'copy report'}
        </button>
        <button type="button" style={BTN} onClick={() => setOpen(false)}>
          hide
        </button>
        {active.size > 0 && (
          <button type="button" style={BTN} onClick={() => location.replace(urlWithSwitches([]))}>
            reset all
          </button>
        )}
      </div>
      {table(live)}
      <div style={{ margin: '8px 0 4px', opacity: 0.6 }}>switch off a suspect (reloads):</div>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {GL_SWITCHES.map((s) => (
          <button key={s.id} type="button" style={active.has(s.id) ? ON : BTN} aria-pressed={active.has(s.id)} onClick={() => toggle(s.id, s.group)}>
            {s.label}
          </button>
        ))}
      </div>
      {fixed && <div style={{ marginTop: 6 }}>{table(fixed)}</div>}
    </div>,
    document.body,
  )
}
