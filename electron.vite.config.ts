import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	main: {},
	preload: {},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [react()],
	},
})
