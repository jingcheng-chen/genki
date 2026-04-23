import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'

// NOTICE:
// StrictMode was intentionally removed here.
// @react-three/fiber v9 + React 19 StrictMode combine badly: the Canvas
// component schedules a 500ms setTimeout on unmount that calls
// `forceContextLoss()` and clears the internal `_roots` entry, and in
// StrictMode the simulated unmount fires BEFORE the real second mount.
// The real mount reuses the root, but the deferred forceContextLoss
// still fires ~500ms later and kills the WebGL context — so the scene
// renders one frame then goes black.
// Root cause: node_modules/@react-three/fiber/dist/react-three-fiber.cjs.dev.js
//   - `useEffect(..., [])` cleanup calls `unmountComponentAtNode`
//   - `events.unmountComponentAtNode` setTimeout(forceContextLoss, 500)
// Removal condition: when R3F tracks remount vs real-unmount and cancels
// the pending setTimeout on re-mount (tracking issue: pmndrs/react-three-fiber).
createRoot(document.getElementById('root')!).render(<App />)
