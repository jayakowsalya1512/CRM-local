import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/fonts/local-fonts.css'
import './index.css'
import { applyThemeFromCache } from '@/hooks/UseTheme'

import { installPhoneGuard } from '@/utils/phoneGuard'

// Apply saved theme instantly before first render — prevents colour flash
applyThemeFromCache()
// Phone / mobile inputs in every form: digits only, never more than 10
installPhoneGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
