import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { THEMES } from '../src/shared/theme.ts'
import { KINDS, languageFor, pieces, sideLines, type LineTokens } from '../src/renderer/src/syntax.ts'
import { knownLanguage, tokenize } from '../src/renderer/src/syntaxEngine.ts'
import type { Hunk } from '../src/shared/types.ts'

// A line's tokens as kind:text pairs, '.' for plain.
async function read(path: string, lines: Array<string>): Promise<Array<Array<string>>> {
	const t = await tokenize(path, lines)
	assert.ok(t, `${path} has a grammar`)
	return lines.map((line, i) => {
		const out: Array<string> = []
		let at = 0
		for (let k = 0; k < t[i].length; k += 2) {
			out.push(`${KINDS[t[i][k + 1]] || '.'}:${line.slice(at, at + t[i][k])}`)
			at += t[i][k]
		}
		assert.equal(at, line.length, `tokens cover line ${i + 1}`)
		return out
	})
}

test('syntax: files are read by their name or extension, plain when there is no grammar', () => {
	const cases: Array<[string, string | null]> = [
		['src/a.ts', 'typescript'],
		['src/A.TSX', 'tsx'],
		['lib/x.py', 'python'],
		['include/x.h', 'c'],
		['x.hpp', 'cpp'],
		['mix.exs', 'elixir'],
		['Dockerfile', 'docker'],
		['deploy/Dockerfile.prod', 'docker'],
		['web.dockerfile', 'docker'],
		['Makefile', 'make'],
		['Gemfile', 'ruby'],
		['.env.local', 'dotenv'],
		['icons/logo.svg', 'xml'],
		['.github/workflows/ci.yml', 'yaml'],
		['notes.txt', null],
		['LICENSE', null],
		['.gitignore', null],
		['yarn.lock', null],
	]
	for (const [path, lang] of cases) assert.equal(languageFor(path, knownLanguage), lang, path)
})

test('syntax: every name the app maps a file to is a grammar Shiki has', async () => {
	const src = readFileSync(new URL('../src/renderer/src/syntax.ts', import.meta.url), 'utf8')
	const maps = src.slice(src.indexOf('const BY_NAME'), src.indexOf('export function languageFor'))
	const names = [...maps.matchAll(/:\s*'([\w-]+)'/g)].map((m) => m[1])
	assert.ok(names.length > 20)
	for (const n of names) assert.ok(knownLanguage(n), n)
})

test('syntax: a docstring is a string on every line, and code inside an f-string is code', async () => {
	const lines = await read('a.py', [
		'def check(self) -> None:',
		'    """A link goes from the key.',
		'    and on to the child',
		'    """',
		'    x = f"Field {field!r}"',
		'    if x is not None and y in z:',
		'        raise ConfigError(0x1F)  # why',
	])
	assert.deepEqual(lines[0].slice(0, 3), ['keyword:def', '.: ', 'function:check'])
	assert.deepEqual(lines[2], ['string:    and on to the child'])
	assert.deepEqual(lines[3].at(-1), 'string:    """')
	assert.ok(lines[4].includes('string:f"Field ') && lines[4].includes('.:field'), lines[4].join(' '))
	assert.ok(['keyword:is', 'keyword:not', 'keyword:and', 'keyword:in'].every((t) => lines[5].includes(t)))
	assert.ok(lines[5].includes('.: x '), 'operators and names stay plain')
	assert.ok(lines[6].includes('constant:0x1F') && lines[6].includes('comment:# why'), lines[6].join(' '))
})

test('syntax: a long file is read in chunks without losing its place, and a cancelled read stops', async () => {
	const lines = ['const a = `start', ...Array.from({ length: 900 }, (_, i) => `line ${i}`), 'end`', 'const b = 1']
	const t = await read('a.ts', lines)
	assert.deepEqual(t[450], ['string:line 449'])
	assert.equal(t.at(-1)![0], 'keyword:const')
	assert.equal(await tokenize('a.ts', lines, async () => false), null)
	assert.equal(await tokenize('notes.txt', ['hello']), null)
	assert.equal(await tokenize('a.ts', ['x'.repeat(1_000_001)]), null)
})

test('syntax: deleted lines are read in the old file, rebuilt from the new file and the diff', () => {
	const fileLines = ['a', 'B', 'c', 'd', 'e']
	const hunks: Array<Hunk> = [
		{
			oldStart: 2,
			oldCount: 1,
			newStart: 2,
			newCount: 1,
			section: '',
			lines: [
				{ kind: 'del', oldNo: 2, newNo: null, text: 'b' },
				{ kind: 'add', oldNo: null, newNo: 2, text: 'B' },
			],
		},
		{
			oldStart: 4,
			oldCount: 2,
			newStart: 4,
			newCount: 1,
			section: '',
			lines: [
				{ kind: 'ctx', oldNo: 4, newNo: 4, text: 'd' },
				{ kind: 'del', oldNo: 5, newNo: null, text: 'x' },
			],
		},
		{
			oldStart: 6,
			oldCount: 0,
			newStart: 5,
			newCount: 1,
			section: '',
			lines: [{ kind: 'add', oldNo: null, newNo: 5, text: 'e' }],
		},
	]
	assert.deepEqual(sideLines(hunks, fileLines), { old: ['a', 'b', 'c', 'd', 'x'], new: fileLines })
	// Without the new file, lines outside the diff are empty.
	assert.deepEqual(sideLines(hunks.slice(1), null), { old: ['', '', '', 'd', 'x'], new: ['', '', '', 'd', 'e'] })
})

test('syntax: a line is cut into runs of one kind, marked characters whole, and wrong tokens are ignored', () => {
	const tok = (...pairs: Array<[number, string]>): LineTokens => pairs.flatMap(([n, k]) => [n, KINDS.indexOf(k as never)])
	const show = (text: string, t: LineTokens | null, marks: Array<{ start: number; end: number }> = []): Array<string> =>
		pieces(text, t, marks).map((p) => `${p.mark !== null ? 'mark' : KINDS[p.kind] || '.'}:${text.slice(p.start, p.end)}`)
	assert.deepEqual(show('if x', tok([2, 'keyword'], [1, ''], [1, ''])), ['keyword:if', '.: x'])
	assert.deepEqual(show('"ab​c"', tok([6, 'string']), [{ start: 3, end: 4 }]), ['string:"ab', 'mark:​', 'string:c"'])
	// A mark across a token's end isn't drawn twice.
	assert.deepEqual(show('abcd', tok([2, 'keyword'], [2, 'string']), [{ start: 1, end: 3 }]), ['keyword:a', 'mark:bc', 'string:d'])
	assert.deepEqual(show('abc', tok([2, 'keyword'])), ['.:abc'])
	assert.deepEqual(show('abc', null), ['.:abc'])
	assert.deepEqual(show('', tok()), [])
})

// The colours each theme gives code, light and dark, as styles.css and themes.css set them on the window.
function themeColours(): Map<string, Record<string, string>> {
	const css = ['styles.css', 'themes.css']
		.map((f) => readFileSync(new URL(`../src/renderer/src/${f}`, import.meta.url), 'utf8'))
		.join('\n')
		.replace(/\/\*[\s\S]*?\*\//g, '')
	const rules: Array<{ dark: boolean; selectors: Array<string>; vars: Record<string, string> }> = []
	const walk = (text: string, dark: boolean): void => {
		let depth = 0
		let start = 0
		let head = ''
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '{') {
				if (depth === 0) {
					head = text.slice(start, i).trim()
					start = i + 1
				}
				depth++
			} else if (text[i] === '}') {
				depth--
				if (depth > 0) continue
				const body = text.slice(start, i)
				if (head.startsWith('@media (prefers-color-scheme: dark)')) walk(body, true)
				else if (!head.startsWith('@')) {
					const vars: Record<string, string> = {}
					for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
					rules.push({ dark, selectors: head.split(',').map((s) => s.trim()), vars })
				}
				start = i + 1
			}
		}
	}
	walk(css, false)
	const out = new Map<string, Record<string, string>>()
	for (const t of THEMES)
		for (const dark of [false, true]) {
			const own = t.id === 'review' ? ':root' : `[data-theme='${t.id}']`
			const vars: Record<string, string> = {}
			for (const r of rules)
				if ((!r.dark || dark) && r.selectors.some((s) => s === ':root' || s === '[data-theme]' || s === own)) Object.assign(vars, r.vars)
			out.set(`${t.id} ${dark ? 'dark' : 'light'}`, vars)
		}
	return out
}

function luminance(hex: string): number {
	const h = hex.replace('#', '')
	const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)
	const [r, g, b] = [0, 2, 4].map((i) => {
		const c = parseInt(full.slice(i, i + 2), 16) / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
	const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
	return (x + 0.05) / (y + 0.05)
}

test('syntax: every theme colours code in both light and dark, readable on plain, added and deleted lines', () => {
	const colours = themeColours()
	const syn = ['comment', 'keyword', 'string', 'constant', 'function', 'type', 'tag', 'attr']
	const failures: Array<string> = []
	for (const [name, vars] of colours) {
		// The high-contrast theme keeps code at AAA, as its body text is; the others at AA.
		const min = name.startsWith('contrast') ? 7 : 4.5
		for (const k of syn) {
			const fg = vars[`--syn-${k}`]
			assert.match(fg ?? '', /^#[0-9a-f]{6}$/i, `${name} --syn-${k}`)
			for (const bg of ['--bg', '--add-bg', '--del-bg']) {
				const c = contrast(fg, vars[bg])
				if (c < min) failures.push(`${name}: --syn-${k} ${fg} on ${bg} ${vars[bg]} is ${c.toFixed(2)}`)
			}
		}
	}
	assert.deepEqual(failures, [])
})
