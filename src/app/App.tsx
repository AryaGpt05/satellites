/**
 * Integration root — owned by the integrator.
 * Dev sandboxes: append ?sandbox=<name> to render src/sandbox/<name>.tsx (default export) in isolation.
 * The production app is lazy-loaded so sandbox pages never import unfinished modules.
 */
import { lazy, Suspense, type ComponentType } from 'react'

// Sandboxes are dev-only: production builds never bundle them (or their fixtures).
const sandboxes = (import.meta.env.DEV ? import.meta.glob('../sandbox/*.tsx') : {}) as Record<
  string,
  () => Promise<{ default: ComponentType }>
>
const sandboxName = import.meta.env.DEV ? new URLSearchParams(location.search).get('sandbox') : null
const sandboxLoader = sandboxName ? sandboxes[`../sandbox/${sandboxName}.tsx`] : undefined
const Root = sandboxLoader ? lazy(sandboxLoader) : lazy(() => import('./Main'))

export function App() {
  if (sandboxName && !sandboxLoader)
    return (
      <pre className="t-mono" style={{ padding: 24 }}>
        No sandbox "{sandboxName}". Available: {Object.keys(sandboxes).join(', ')}
      </pre>
    )
  return (
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  )
}
