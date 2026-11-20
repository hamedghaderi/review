import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build, type Rollup } from 'vite'
import { markdownBlocks } from '../src/renderer/src/markdownBlocks.ts'

/** One of the app's renderer modules, bundled with what it imports, as a script that sets the global `App` to it. */
async function bundle(module: string): Promise<string> {
	const entry = fileURLToPath(new URL(`../src/renderer/src/${module}`, import.meta.url))
	const out = (await build({
		configFile: false,
		logLevel: 'silent',
		// One script: code a module loads on demand (Mermaid's diagram types) is put in it too.
		build: {
			write: false,
			minify: false,
			lib: { entry, formats: ['iife'], name: 'App' },
			rollupOptions: { output: { inlineDynamicImports: true } },
		},
	})) as Array<Rollup.RollupOutput> | Rollup.RollupOutput
	const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).find((c) => c.type === 'chunk')
	assert.ok(chunk, `no bundle for ${module}`)
	return chunk.code
}

/**
 * Runs code in Chromium (a hidden Electron window, with its own throwaway data folder) and returns what it evaluates
 * to. For checks whose answer depends on the browser engine, which Node's tests can't show.
 */
function inChromium(code: string, page?: { html: string; files: Record<string, string> }): unknown {
	const dir = mkdtempSync(join(tmpdir(), 'review-chromium-'))
	try {
		const main = join(dir, 'main.cjs')
		const script = join(dir, 'code.js')
		writeFileSync(script, code)
		if (page) {
			writeFileSync(join(dir, 'page.html'), page.html)
			for (const [name, text] of Object.entries(page.files)) writeFileSync(join(dir, name), text)
		}
		writeFileSync(
			main,
			`const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.setPath('userData', ${JSON.stringify(join(dir, 'data'))})
app.whenReady().then(async () => {
	const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
	await ${page ? `w.loadFile(${JSON.stringify(join(dir, 'page.html'))})` : "w.loadURL('about:blank')"}
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

test(
	"the syntax worker runs under the page's security policy, and no worker starts outside it",
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	async () => {
		// The app's own policy, on a file:// page as the app is.
		const index = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
		const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1]
		assert.ok(csp?.includes('worker-src blob:'), csp)
		// Each of these works in a worker with no policy (a worker loaded straight from file://).
		const probe = `postMessage('hello')
const r = {}
const tryIt = async (k, f) => { try { await f(); r[k] = 'allowed' } catch { r[k] = 'refused' } }
await tryIt('eval', () => new Function('return 1')())
await tryIt('import', () => import('data:text/javascript,export default 1'))
await tryIt('fetch', () => fetch('data:,x'))
addEventListener('message', (e) => postMessage({ ...r, echo: e.data }))`
		const out = inChromium(
			`new Promise((done) => {
				const probe = new URL('probe.js', location.href).href
				const w = App.sandboxedWorker(probe)
				w.postMessage('sent before it loaded')
				w.onmessage = (e) => {
					if (e.data === 'hello') return
					let direct
					try { direct = new Worker(probe, { type: 'module' }); direct.onerror = () => done({ ...e.data, direct: 'refused' }) } catch { done({ ...e.data, direct: 'refused' }) }
					if (direct) direct.onmessage = () => done({ ...e.data, direct: 'started' })
					setTimeout(() => done({ ...e.data, direct: 'no answer' }), 3000)
				}
				w.onerror = () => done('the sandboxed worker failed to start')
				setTimeout(() => done('timeout'), 10000)
			})`,
			{
				html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="app.js"></script>`,
				files: { 'app.js': await bundle('sandboxedWorker.ts'), 'probe.js': probe },
			},
		)
		assert.deepEqual(out, { eval: 'refused', import: 'refused', fetch: 'refused', echo: 'sent before it loaded', direct: 'refused' })
	},
)

test(
	'Tab in a text box in Chromium: typed through the browser, so the box hears it and one ⌘Z undoes it',
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	async () => {
		const out = inChromium(`${await bundle('tabKey.ts')}
			;(() => {
				const box = document.createElement('textarea')
				document.body.append(box)
				box.focus()
				let heard = false
				box.addEventListener('input', () => { heard = true })
				const press = (text, start, end, shiftKey = false) => {
					box.value = text
					box.setSelectionRange(start, end)
					heard = false
					let prevented = false
					const handled = App.tabKey({
						key: 'Tab', shiftKey, ctrlKey: false, metaKey: false, altKey: false, nativeEvent: { isComposing: false },
						currentTarget: box, preventDefault: () => { prevented = true },
					})
					const after = { handled, prevented, heard, value: box.value, sel: [box.selectionStart, box.selectionEnd] }
					document.execCommand('undo')
					return { ...after, undone: box.value }
				}
				const r = {
					empty: press('', 0, 0),
					typed: press('def f():\\n\\nx', 9, 9),
					indented: press('a\\nb', 0, 3),
					outdented: press('\\ta\\n\\tb', 0, 5, true),
					nothing: press('a\\nb', 0, 3, true),
				}
				box.readOnly = true
				r.readOnly = press('a', 1, 1)
				return r
			})()`) as Record<string, unknown>
		const no = (value: string, sel: [number, number]) => ({ handled: false, prevented: false, heard: false, value, sel, undone: value })
		const yes = (value: string, sel: [number, number], undone: string) => ({
			handled: true,
			prevented: true,
			heard: true,
			value,
			sel,
			undone,
		})
		assert.deepEqual(out, {
			empty: no('', [0, 0]),
			typed: yes('def f():\n\t\nx', [10, 10], 'def f():\n\nx'),
			indented: yes('\ta\n\tb', [0, 5], 'a\nb'),
			outdented: yes('a\nb', [0, 3], '\ta\n\tb'),
			nothing: no('a\nb', [0, 3]),
			readOnly: no('a', [1, 1]),
		})
	},
)

test(
	'a Markdown file rendered in Chromium: what the file says can run nothing, style nothing, or load anything',
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	async () => {
		const file = [
			'<script>window.ran = "script"</script>', // 1
			'',
			'<img src="x" onerror="window.ran = \'onerror\'">', // 3
			'',
			'[run](javascript:window.ran=1) [site](https://example.com) [doc](docs/other.md)', // 5
			'',
			'<iframe src="https://example.com"></iframe>', // 7
			'',
			'<p style="position: fixed; inset: 0">over the app</p>', // 9
			'',
			'![flow](docs/flow.png)', // 11
			'',
			'- [x] done', // 13
			'- [ ] next', // 14
		].join('\n')
		const blocks = markdownBlocks(file, { added: new Set([14]), cuts: [] })
		const out = inChromium(`${await bundle('markdownHtml.ts')}
			;(async () => {
				const box = document.createElement('div')
				box.append(App.renderBlocks(${JSON.stringify(blocks)}, document))
				document.body.append(box)
				await new Promise((r) => setTimeout(r, 300)) // time for an image error or a frame to load
				return {
					ran: window.ran ?? null,
					handlers: [...box.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith('on')),
					tags: ['script', 'iframe', 'img', '[style]'].filter((t) => box.querySelector(t)),
					links: [...box.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
					text: box.textContent.replace(/\\s+/g, ' ').trim(),
					boxes: [...box.querySelectorAll('input')].map((i) => [i.type, i.checked, i.disabled]),
					changed: [...box.querySelectorAll('[data-changed]')].map((el) => [el.tagName, el.dataset.start, el.dataset.end]),
				}
			})()`) as Record<string, unknown>
		assert.equal(out.ran, null)
		assert.deepEqual(out.handlers, [])
		assert.deepEqual(out.tags, [])
		// Web links open outside the app; others keep only their words.
		assert.deepEqual(out.links, [['site', 'https://example.com/', '_blank']])
		assert.match(out.text as string, /run site doc/)
		assert.match(out.text as string, /🖼 flow/)
		assert.deepEqual(out.boxes, [
			['checkbox', true, true],
			['checkbox', false, true],
		])
		assert.deepEqual(out.changed, [['LI', '14', '14']])
	},
)

test(
	'Mermaid diagrams in Chromium, under the app’s content security policy: drawn only when asked, as images, and a diagram can loosen nothing',
	{ skip: noDisplay && 'needs a display (run under xvfb-run)' },
	async () => {
		const csp = /content="(default-src[^"]*)"/.exec(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'))![1]
		const diagrams = [
			'flowchart LR\n  accTitle: Checkout\n  A[Cart] --> B[Charge<br/>the card]',
			'%%{init: {"securityLevel": "loose", "theme": "forest", "themeCSS": "body { display: none; outline: 9px solid red }"}}%%\nflowchart TD\n  X["<img src=x onerror=window.ran=1>"] --> Y\n  click X call window.alert("hi")',
			'this is not a diagram',
		]
		const out = inChromium(
			`${await bundle('mermaidDiagrams.ts')}
			;(async () => {
				const violations = []
				document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective))
				const view = () => {
					const root = document.createElement('div')
					document.body.append(root)
					for (const text of ${JSON.stringify(diagrams)}) {
						const pre = document.createElement('pre')
						const code = Object.assign(document.createElement('code'), { className: 'language-mermaid', textContent: text })
						pre.append(code)
						root.append(pre)
					}
					return root
				}
				const settle = async (root) => {
					for (let i = 0; i < 200 && root.querySelector('.mermaid-pending'); i++) await new Promise((r) => setTimeout(r, 100))
					await new Promise((r) => setTimeout(r, 500)) // the images decode
				}
				const asked = new Set()
				const root = view()
				App.offerDiagrams(root, asked)
				await new Promise((r) => setTimeout(r, 300))
				const offered = {
					buttons: [...root.querySelectorAll('button.mermaid-draw')].map((b) => b.textContent),
					figures: root.querySelectorAll('figure').length,
					pending: root.querySelectorAll('.mermaid-pending').length,
				}
				for (const b of root.querySelectorAll('button.mermaid-draw')) b.click()
				await settle(root)
				// The view drawn again (a theme change): what you asked for is drawn without asking.
				const again = view()
				App.offerDiagrams(again, asked)
				await settle(again)
				const imgs = [...root.querySelectorAll('figure.mermaid-diagram img')]
				return {
					offered,
					buttonsLeft: root.querySelectorAll('button.mermaid-draw').length,
					redrawn: { buttons: again.querySelectorAll('button.mermaid-draw').length, figures: again.querySelectorAll('figure').length },
					drawn: imgs.map((i) => [i.alt, i.naturalWidth > 0]),
					left: [...root.querySelectorAll('pre')].map((p) => p.textContent),
					errors: root.querySelectorAll('.mermaid-error').length,
					ran: window.ran ?? null,
					display: getComputedStyle(document.body).display,
					inPage: document.querySelectorAll('svg, body style').length,
					overridden: imgs.some((i) => /9px solid red|#cde498/i.test(decodeURIComponent(i.src))), // its CSS, or forest's colours
					handlersInDrawing: imgs.some((i) => /\\son[a-z]+\\s*=/i.test(decodeURIComponent(i.src))),
					violations,
				}
			})()`,
			{ html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body></body>`, files: {} },
		) as Record<string, unknown>
		// Nothing is drawn until you ask.
		assert.deepEqual(out.offered, { buttons: ['Draw diagram', 'Draw diagram', 'Draw diagram'], figures: 0, pending: 0 })
		assert.equal(out.buttonsLeft, 0)
		assert.deepEqual(out.redrawn, { buttons: 0, figures: 2 })
		assert.deepEqual(out.drawn, [
			['Checkout', true],
			['Diagram', true],
		])
		assert.deepEqual(out.left, ['this is not a diagram'])
		assert.equal(out.errors, 1)
		assert.equal(out.ran, null)
		assert.equal(out.display, 'block')
		assert.equal(out.overridden, false) // the diagram's own theme and CSS were refused
		assert.equal(out.inPage, 0) // nothing Mermaid drew stays in the page itself
		// Mermaid keeps the label's <img> but not its handler; inside a drawing shown as an image it can't load anyway.
		assert.equal(out.handlersInDrawing, false)
		assert.deepEqual(out.violations, [])
	},
)
