import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	main: {},
	preload: {},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [react()],
		define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version) },
	},
})
