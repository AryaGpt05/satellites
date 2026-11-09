/** The admin stats page (/admin): a separate Vite entry, never part of the app's bundle. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/fonts.css'
import '../styles/tokens.css'
import './admin.css'
import { Admin } from './Admin'

createRoot(document.getElementById('admin')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
)
