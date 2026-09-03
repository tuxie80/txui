import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RevealGate } from './components/RevealGate'
import { installInputBehaviour } from './utils/inputBehaviour'
import { hydrateFolderMeta } from './store/folderMeta'
import { invoke } from '@tauri-apps/api/core'
import { getPref, PREFS } from './store/preferences'

// Before the first render: no autofill, autocorrect, capitalisation or
// spellcheck on any text box in the app. See utils/inputBehaviour.ts.
installInputBehaviour()

// Folder colours/notes/replica-set flags now live with the connections rather
// than in localStorage. Load them (migrating any legacy copy) before the
// sidebar first paints, so folders never flash unstyled.
void hydrateFolderMeta()

// Push the saved connect timeout to the backend before anything can connect —
// otherwise the first connection of the run would use the compiled default
// rather than the value in Settings.
invoke('set_connect_timeout', { secs: getPref(PREFS.connectTimeoutSecs) }).catch(() => {})
// Same reasoning for the query deadline: a query can be run before Settings is
// ever opened, and the backend would otherwise be holding the compiled 0.
invoke('set_query_timeout', { secs: getPref(PREFS.queryTimeoutSecs) }).catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {/* After ErrorBoundary, so its layout effect runs once the app is
        committed — and it still mounts if App itself threw and the boundary
        rendered its fallback, which must also be revealed. */}
    <RevealGate />
  </StrictMode>,
)
