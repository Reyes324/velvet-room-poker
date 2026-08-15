import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { initViewportHeightFix } from './lib/viewportHeight.js'
import { initKeyboardScrollFix } from './lib/keyboardScrollFix.js'

initViewportHeightFix()
initKeyboardScrollFix()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
