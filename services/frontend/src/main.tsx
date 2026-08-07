import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Authentication from './Authentication.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Authentication />
  </StrictMode>,
)
