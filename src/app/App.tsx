/**
 * Integration root — owned by the integrator. Modules are composed here.
 * Dev sandboxes: append ?sandbox=<name> to render src/sandbox/<name>.tsx (default export) in isolation.
 */
import { lazy, Suspense } from 'react'

const sandboxes = import.meta.glob('../sandbox/*.tsx')
const sandboxName = new URLSearchParams(location.search).get('sandbox')

export function App() {
  if (sandboxName) {
    const key = `../sandbox/${sandboxName}.tsx`
    const loader = sandboxes[key] as undefined | (() => Promise<{ default: React.ComponentType }>)
    if (!loader) return <pre className="t-mono" style={{ padding: 24 }}>No sandbox "{sandboxName}". Available: {Object.keys(sandboxes).join(', ')}</pre>
    const Comp = lazy(loader)
    return (
      <Suspense fallback={null}>
        <Comp />
      </Suspense>
    )
  }
  return (
    <main style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
      <span className="t-label">Overflight — scaffold</span>
    </main>
  )
}
