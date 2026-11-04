import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@shared/ui/base.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker only for this app (scope /poll-worker/) and only in production builds,
// so the app opens without network (RT-6). The public page registers none.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/poll-worker/sw.js', { scope: '/poll-worker/' }).catch(() => {})
  })
}
