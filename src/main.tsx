import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './app/App'

// Vercel Web Analytics (cookieless). Production only, loaded after first paint so it never competes with boot.
if (import.meta.env.PROD) {
  const load = () => import('@vercel/analytics').then(({ inject }) => inject({ mode: 'production' })).catch(() => undefined)
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 4000 })
  else setTimeout(load, 2000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
