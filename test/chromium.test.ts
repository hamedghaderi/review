import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import electron from 'electron'

/**
 * Runs code in Chromium (a hidden Electron window, with its own throwaway data folder) and returns what it evaluates
 * to. For checks whose answer depends on the browser engine, which Node's tests can't show.
 */
function inChromium(code: string): unknown {
	const dir = mkdtempSync(join(tmpdir(), 'review-chromium-'))
	try {
		const main = join(dir, 'main.cjs')
		const script = join(dir, 'code.js')
		writeFileSync(script, code)
		writeFileSync(
			main,
			`const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.setPath('userData', ${JSON.stringify(join(dir, 'data'))})
app.whenReady().then(async () => {
	const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
	await w.loadURL('about:blank')
	const out = await w.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(script)}, 'utf8'))
	process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n')
	app.quit()
}).catch((e) => { console.error(e); app.exit(1) })`,
		)
		// CI has no sandbox setup for Chromium on Linux; this window only ever loads the code above.
		const args = [main, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
		const env = { ...process.env }
		delete env.ELECTRON_RUN_AS_NODE
		const run = spawnSync(electron as unknown as string, args, { encoding: 'utf8', timeout: 60_000, env })
		const line = run.stdout?.split('\n').find((l) => l.startsWith('RESULT '))
		assert.ok(line, `Electron gave no result (status ${run.status}): ${run.stderr || run.error?.message}`)
		return JSON.parse(line.slice('RESULT '.length))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.CI

test(
	'webUrl in Chromium: hosts its parser would take but no browser opens are turned down',
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	() => {
		const source = readFileSync(new URL('../src/renderer/src/commentLinks.ts', import.meta.url), 'utf8')
		const js = stripTypeScriptTypes(source).replace(/^export /gm, '')
		const cases = [
			'https://exa mple.com/',
			'https://exa%20mple.com/',
			'https://exa%41mple.com/',
			'https://-bad.example/',
			'https://l·l.cat/',
			'https://github.com/x',
		]
		const out = inChromium(`(() => { ${js}
		return { parser: (() => { try { return new URL('https://exa mple.com/').hostname } catch { return null } })(),
			results: ${JSON.stringify(cases)}.map((u) => webUrl(u)) } })()`) as { parser: string | null; results: Array<string | null> }
		assert.deepEqual(out.results, [null, null, null, null, 'https://xn--ll-0ea.cat/', 'https://github.com/x'])
		// Why this test exists: Chromium's own parser takes the space (Node's throws). If that ever changes, the check
		// above is still right; this line just says the difference is gone.
		assert.equal(out.parser, 'exa%20mple.com', 'Chromium no longer accepts a space in a host; the Chromium test may be unneeded')
	},
)
