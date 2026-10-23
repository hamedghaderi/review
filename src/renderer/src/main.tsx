import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import './themes.css'
import { startTheme } from './theme.ts'
import { startKeymap } from './keymap.ts'

document.title = `Review ${__APP_VERSION__}`
startTheme()
startKeymap()

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
