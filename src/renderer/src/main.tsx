import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Announcer } from './Announcer.tsx'
import { App } from './App.tsx'
import './styles.css'
import './themes.css'
import { startTheme } from './theme.ts'
import { startKeymap } from './keymap.ts'
import { startMotion } from './motion.ts'

document.title = `Review ${__APP_VERSION__}`
startTheme()
startKeymap()
startMotion()

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
		<Announcer />
	</StrictMode>,
)
