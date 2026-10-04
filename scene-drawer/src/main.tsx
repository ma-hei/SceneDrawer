import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import SceneViewer from './scene/SceneViewer.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SceneViewer />
  </StrictMode>,
)
