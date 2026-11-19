import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	main: {
		// The app, and the read-only MCP server your coding agent starts from the app's binary (issue #200).
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, 'src/main/index.ts'), agent: resolve(__dirname, 'src/main/agent.ts') },
			},
		},
	},
	preload: {},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [react()],
		// The syntax worker loads each language's grammar when first needed, which needs module workers.
		worker: { format: 'es' },
		define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version) },
	},
})
