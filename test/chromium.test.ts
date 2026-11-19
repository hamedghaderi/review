import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build, type Rollup } from 'vite'

/** One of the app's renderer modules, bundled with what it imports, as a script that sets the global `App` to it. */
async function bundle(module: string): Promise<string> {
	const entry = fileURLToPath(new URL(`../src/renderer/src/${module}`, import.meta.url))
	const out = (await build({
		configFile: false,
		logLevel: 'silent',
		build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'App' } },
	})) as Array<Rollup.RollupOutput> | Rollup.RollupOutput
	const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).find((c) => c.type === 'chunk')
	assert.ok(chunk, `no bundle for ${module}`)
	return chunk.code
}

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
	async () => {
		const cases = [
			'https://exa mple.com/',
			'https://exa%20mple.com/',
			'https://exa%41mple.com/',
			'https://-bad.example/',
			'https://l·l.cat/',
			'https://github.com/x',
		]
		const out = inChromium(`${await bundle('commentLinks.ts')}
			;({ parser: (() => { try { return new URL('https://exa mple.com/').hostname } catch { return null } })(),
				results: ${JSON.stringify(cases)}.map((u) => App.webUrl(u)) })`) as { parser: string | null; results: Array<string | null> }
		assert.deepEqual(out.results, [null, null, null, null, 'https://xn--ll-0ea.cat/', 'https://github.com/x'])
		// Why this test exists: Chromium's own parser takes the space (Node's throws). If that ever changes, the check
		// above is still right; this line just says the difference is gone.
		assert.equal(out.parser, 'exa%20mple.com', 'Chromium no longer accepts a space in a host; the Chromium test may be unneeded')
	},
)

test(
	'comment previews in Chromium, from GitHub-style HTML through the real sanitising',
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	async () => {
		const icon = (src: string) => `<img src="${src}" width="16" height="16" alt="">`
		const previews = {
			divider: '<hr>',
			iconAndDivider: `<p>${icon('https://camo.githubusercontent.com/i')}</p><hr>`,
			twoIconsOneLink: `<p><a href="https://example.com/i.png">${icon('https://example.com/i.png')}${icon('https://example.com/i.png')}</a></p>`,
			altText: '<p><img src="https://github.com/u/d.png" alt="<!-- diagram -->"></p>',
			numbered: '<ol start="3"><li>Build</li><li>Repeat step 3</li></ol>',
			wrappedSuggestion:
				'<table><tr><td class="blob-num"></td><td class="blob-code-inner blob-code-addition"><div>return 1</div></td></tr></table>',
			blankSummary: '<details><summary> </summary><p>folded</p></details>',
			openNoSummary: '<details open><p>Fix this</p></details>',
			itemParagraph: '<ol><li><p>First step</p><p>more</p></li></ol>',
			whitespaceCode: '<pre><code>   \n\n  \n</code></pre>',
			blocksInSuggestion: '<table><tr><td class="blob-code-inner blob-code-addition"><div>one</div><div>two</div></td></tr></table>',
			tabsAndNbsp: '<pre><code>a\tx\nab\tx\n\u00a0\u00a0kept</code></pre>',
			srcsetOnly: '<p><picture><source srcset="https://github.com/u/wide.png 2x"><img alt="diagram"></picture></p>',
			trailingBlank: '<pre><code>a\n\n</code></pre><p>After</p>',
			nestedBlocks: '<table><tr><td class="blob-code-inner blob-code-addition"><div><div>one</div></div><div>two</div></td></tr></table>',
		}
		// What standIns makes of it for the comment itself: the link, not only its words.
		const rendered = {
			srcsetLink:
				'<p><picture><source srcset="https://github.com/u/wide.png 2x, https://github.com/u/x.png 1x"><img alt="diagram"></picture></p>',
			srcsetComma: '<p><picture><source srcset="https://example.com/plots/a,b.png 2x"><img alt="plot"></picture></p>',
		}
		const out = inChromium(`${await bundle('commentHtml.ts')}
			;({
				rendered: Object.fromEntries(Object.entries(${JSON.stringify(rendered)}).map(([k, html]) => {
					const box = document.createElement('div')
					box.innerHTML = html
					App.standIns(box, document, false)
					return [k, box.innerHTML]
				})),
				previews: Object.fromEntries(Object.entries(${JSON.stringify(previews)}).map(([k, html]) => [k, App.commentText({ body: '', html })])),
			})`) as { previews: Record<string, string>; rendered: Record<string, string> }
		assert.deepEqual(out.previews, {
			divider: 'Divider',
			iconAndDivider: 'Divider',
			twoIconsOneLink: '🔗 example.com',
			altText: '🖼 image',
			numbered: '3. Build\n4. Repeat step 3',
			wrappedSuggestion: '+ return 1',
			blankSummary: 'Details',
			openNoSummary: 'Details\nFix this',
			itemParagraph: '1. First step\nmore',
			whitespaceCode: 'No visible text.',
			blocksInSuggestion: '+ one\ntwo',
			tabsAndNbsp: 'a\tx\nab\tx\n\u00a0\u00a0kept',
			srcsetOnly: '🖼 diagram',
			trailingBlank: 'a\n\nAfter',
			nestedBlocks: '+ one\ntwo',
		})
		assert.match(out.rendered.srcsetComma, /href="https:\/\/example\.com\/plots\/a,b\.png"/)
		assert.match(out.rendered.srcsetLink, /<a [^>]*href="https:\/\/github\.com\/u\/wide\.png"[^>]*>🖼 diagram<\/a>/)
	},
)
