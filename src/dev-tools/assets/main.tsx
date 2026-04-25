import { createRoot } from 'react-dom/client'
import '../../index.css'
import { AssetManager } from './AssetManager'

// Same StrictMode caveat as the main entry — see src/main.tsx for the
// long-form explanation. R3F v9 + React 19 StrictMode will kill the WebGL
// context here too.
createRoot(document.getElementById('root')!).render(<AssetManager />)
