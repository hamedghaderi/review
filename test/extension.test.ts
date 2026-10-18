import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parsePrLink } from '../src/shared/link.ts'

const SCRIPTS = {
	extension: readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'),
	userscript: readFileSync(new URL('../site/open-in-review.user.js', import.meta.url), 'utf8'),
}

interface Key {
	key: string
	code?: string
	shiftKey?: boolean
	altKey?: boolean
	ctrlKey?: boolean
	metaKey?: boolean
	repeat?: boolean
	target?: { isContentEditable?: boolean; closest?: (s: string) => unknown }
}

/** Loads a script into a fake github.com page and returns a function that presses a key at an address. */
function page(source: string, stored: unknown = null) {
	let onKey: ((e: unknown) => void) | null = null
	const location = { pathname: '/', href: 'https://github.com/' }
	const chrome = {
		storage: {
			sync: { get: (defaults: { shortcut: unknown }, cb: (v: unknown) => void) => cb({ shortcut: stored ?? defaults.shortcut }) },
			onChanged: { addListener: () => {} },
		},
	}
	const document = { addEventListener: (type: string, fn: (e: unknown) => void) => type === 'keydown' && (onKey = fn) }
	runInNewContext(source, { document, location, chrome })
	return (pathname: string, k: Key): { href: string; prevented: boolean } => {
		location.pathname = pathname
		location.href = `https://github.com${pathname}`
		let prevented = false
		onKey!({
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			repeat: false,
			isComposing: false,
			target: { isContentEditable: false, closest: () => null },
			...k,
			preventDefault: () => (prevented = true),
		})
		return { href: location.href, prevented }
	}
}

const SHIFT_R = { key: 'R', code: 'KeyR', shiftKey: true }

for (const [name, source] of Object.entries(SCRIPTS)) {
	test(`${name}: Shift+R on a pull request opens it in the app with a link the app accepts`, () => {
		const press = page(source)
		for (const path of ['/hamedghaderi/review/pull/58', '/hamedghaderi/review/pull/58/files', '/a-b/c.d_e/pull/7/commits/abc']) {
			const r = press(path, SHIFT_R)
			assert.ok(r.prevented, path)
			assert.match(r.href, /^review-code:\/\/open\//)
			assert.ok(parsePrLink(r.href), `${r.href} is a link the app opens`)
		}
	})

	test(`${name}: other pages, other keys and typing keep the key`, () => {
		const press = page(source)
		const untouched = (path: string, k: Key) => {
			const r = press(path, k)
			assert.equal(r.prevented, false, `${path} ${JSON.stringify(k)}`)
			assert.match(r.href, /^https:\/\/github\.com\//)
		}
		const pr = '/o/r/pull/1'
		for (const path of ['/o/r', '/o/r/pulls', '/o/r/issues/1', '/o/r/pull/new', '/o/../pull/1', '/settings']) untouched(path, SHIFT_R)
		untouched(pr, { key: 'r', code: 'KeyR' }) // GitHub's own "quote reply"
		untouched(pr, { ...SHIFT_R, metaKey: true })
		untouched(pr, { ...SHIFT_R, repeat: true })
		untouched(pr, { ...SHIFT_R, target: { isContentEditable: false, closest: (s) => (s.includes('textarea') ? {} : null) } })
		untouched(pr, { ...SHIFT_R, target: { isContentEditable: true, closest: () => null } })
	})

	test(`${name}: the physical key counts, so Option and other layouts still match`, () => {
		const press = page(source)
		assert.ok(press('/o/r/pull/1', { key: 'Р', code: 'KeyR', shiftKey: true }).prevented) // Cyrillic layout
	})
}

test('extension: a shortcut chosen in options replaces Shift+R', () => {
	const press = page(SCRIPTS.extension, { key: 'o', code: 'KeyO', shift: false, alt: true, ctrl: false, meta: false })
	assert.ok(press('/o/r/pull/1', { key: 'ø', code: 'KeyO', altKey: true }).prevented, 'Option+O types ø on a Mac')
	assert.equal(press('/o/r/pull/1', SHIFT_R).prevented, false)
})

test('extension: asks for no access beyond github.com and its own settings', () => {
	const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
	assert.equal(manifest.manifest_version, 3)
	assert.deepEqual(manifest.permissions, ['storage'])
	assert.equal(manifest.host_permissions, undefined)
	assert.deepEqual(
		manifest.content_scripts.map((c: { matches: Array<string> }) => c.matches),
		[['https://github.com/*']],
	)
	assert.match(SCRIPTS.userscript, /\/\/ @match {8}https:\/\/github\.com\/\*\n/)
	assert.match(SCRIPTS.userscript, /\/\/ @grant {8}none\n/)
})
