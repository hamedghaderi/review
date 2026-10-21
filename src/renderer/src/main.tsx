import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import './themes.css'
import { startTheme } from './theme.ts'

document.title = `Review ${__APP_VERSION__}`
startTheme()

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
