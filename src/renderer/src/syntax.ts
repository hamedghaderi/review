import { computeGaps } from '../../shared/diff.ts'
import type { Hunk } from '../../shared/types.ts'

/**
 * Colouring code by language (issue #237). Shiki reads the code with the same TextMate grammars as VS Code, in a worker
 * (syntaxEngine.ts). It doesn't send colours: each token comes back as one of these kinds, drawn with a `tk-<kind>` class
 * whose colour each theme sets (the --syn-* tokens in styles.css and themes.css), so code follows the theme and light
 * or dark like the rest of the app.
 */
export const KINDS = [
	'', // plain text: the line's own colour
	'comment',
	'keyword',
	'string',
	'constant',
	'function',
	'type',
	'tag',
	'attr',
	'regexp',
	'escape',
	'heading',
	'bold',
	'italic',
	'link',
	'inserted',
	'deleted',
] as const
export type Kind = (typeof KINDS)[number]

// Which grammar scopes are which kind. The most specific scope wins, so `keyword.operator` (= + ->) stays plain while
// word operators (`new`, `typeof`, Python's `and`/`not`) are keywords, and code inside `${…}` or an f-string's braces is
// code again rather than string.
const RULES: Record<Exclude<Kind, ''>, Array<string>> = {
	comment: ['comment', 'punctuation.definition.comment', 'string.comment', 'markup.quote'],
	keyword: [
		'keyword',
		'storage',
		'keyword.operator.new',
		'keyword.operator.expression',
		'keyword.operator.word',
		'keyword.operator.logical.python',
		'keyword.operator.instanceof',
		'keyword.operator.typeof',
		'keyword.operator.delete',
		'keyword.operator.void',
		'keyword.operator.sizeof',
		'keyword.operator.cast',
		'punctuation.definition.template-expression',
		'punctuation.section.embedded',
		'punctuation.definition.list',
	],
	string: [
		'string',
		'punctuation.definition.string',
		'storage.type.string', // Python's f"" and b""
		'markup.inline.raw',
		'markup.raw',
		'constant.other.symbol',
	],
	constant: [
		'constant',
		'support.constant',
		'variable.language',
		'variable.other.constant',
		'variable.other.enummember',
		'entity.name.constant',
		'storage.type.number', // the 0x of 0x1F
	],
	function: [
		'entity.name.function',
		'support.function',
		'meta.function-call.generic',
		'entity.name.function.decorator',
		'punctuation.decorator',
		'meta.decorator punctuation.definition.decorator',
	],
	type: [
		'entity.name.type',
		'entity.name.class',
		'entity.other.inherited-class',
		'support.type',
		'support.class',
		'storage.type.primitive',
		'storage.type.built-in',
	],
	tag: ['entity.name.tag', 'support.class.component'],
	attr: ['entity.other.attribute-name', 'support.type.property-name', 'support.type.vendored.property-name'],
	regexp: ['string.regexp'],
	escape: ['constant.character.escape', 'constant.character.format.placeholder', 'constant.other.placeholder'],
	heading: ['markup.heading', 'entity.name.section'],
	bold: ['markup.bold'],
	italic: ['markup.italic'],
	link: ['markup.underline.link', 'string.other.link'],
	inserted: ['markup.inserted'],
	deleted: ['markup.deleted'],
}
// Kept in the line's own colour, though a broader rule above would colour them.
const PLAIN = [
	'keyword.operator',
	'punctuation',
	'meta.template.expression',
	'meta.embedded',
	'source.groovy.embedded',
	'invalid', // a grammar's guess at an error, often wrong in part of a file
]

/** A kind's stand-in colour in the theme Shiki is given: its index, so the colour of a token says its kind. */
export const kindColor = (i: number): string => `#${i.toString(16).padStart(6, '0')}`

/** The TextMate theme Shiki tokenizes with. Its colours aren't shown; they encode kinds (see kindColor). */
export const KIND_THEME = {
	name: 'review-kinds',
	type: 'light' as const,
	fg: kindColor(0),
	bg: '#ffffff',
	settings: [
		{ settings: { foreground: kindColor(0), background: '#ffffff' } },
		{ scope: PLAIN, settings: { foreground: kindColor(0) } },
		...Object.entries(RULES).map(([kind, scope]) => ({
			scope,
			settings: { foreground: kindColor(KINDS.indexOf(kind as Kind)) },
		})),
	],
}

/** The kind a token's colour stands for, plain for anything unexpected. */
export function kindOf(color: string | undefined): number {
	const n = color ? parseInt(color.slice(1, 7), 16) : 0
	return Number.isInteger(n) && n > 0 && n < KINDS.length ? n : 0
}

/** A line's tokens, flat: a length then a kind index, repeated. Lengths add up to the line's length. */
export type LineTokens = Array<number>

// Files Shiki has no grammar name or alias for by extension, and names without one.
const BY_NAME: Record<string, string> = {
	dockerfile: 'docker',
	containerfile: 'docker',
	makefile: 'make',
	gnumakefile: 'make',
	gemfile: 'ruby',
	rakefile: 'ruby',
	podfile: 'ruby',
	brewfile: 'ruby',
	vagrantfile: 'ruby',
	jenkinsfile: 'groovy',
	'cmakelists.txt': 'cmake',
	pipfile: 'toml',
	'cargo.lock': 'toml',
	'.bashrc': 'shellscript',
	'.bash_profile': 'shellscript',
	'.zshrc': 'shellscript',
	'.profile': 'shellscript',
	'.editorconfig': 'ini',
	'.gitconfig': 'ini',
	'.npmrc': 'ini',
}
const BY_EXT: Record<string, string> = {
	h: 'c',
	hh: 'cpp',
	hpp: 'cpp',
	hxx: 'cpp',
	cc: 'cpp',
	cxx: 'cpp',
	mts: 'typescript',
	cts: 'typescript',
	ex: 'elixir',
	exs: 'elixir',
	pl: 'perl',
	pm: 'perl',
	ml: 'ocaml',
	mli: 'ocaml',
	m: 'objective-c',
	mm: 'objective-cpp',
	svg: 'xml',
	xsd: 'xml',
	plist: 'xml',
	csproj: 'xml',
	props: 'xml',
	gradle: 'groovy',
	cshtml: 'razor',
	patch: 'diff',
	env: 'dotenv',
	webmanifest: 'json',
	ipynb: 'json',
	tfvars: 'terraform',
	rake: 'ruby',
	gemspec: 'ruby',
	podspec: 'ruby',
}

/**
 * The grammar for a file: by its name, then its extension, either looked up in Shiki's own names and aliases
 * (`known`), or null for plain text.
 */
export function languageFor(path: string, known: (name: string) => string | undefined): string | null {
	const base = (path.split('/').pop() ?? '').toLowerCase()
	const named = BY_NAME[base]
	if (named) return known(named) ?? null
	if (base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return known('docker') ?? null
	if (base === '.env' || base.startsWith('.env.')) return known('dotenv') ?? null
	const dot = base.lastIndexOf('.')
	if (dot <= 0) return null
	const ext = base.slice(dot + 1)
	return known(BY_EXT[ext] ?? ext) ?? null
}

/**
 * Each version of a changed file as far as the diff and the new file show it, line n at index n−1, so code is read in
 * its context: a deleted line inside a docstring is coloured as one. With the whole new file, the old one is whole too
 * (unchanged lines are the same in both). Without it, lines the diff doesn't show are empty.
 */
export function sideLines(hunks: Array<Hunk>, fileLines: Array<string> | null): { old: Array<string>; new: Array<string> } {
	const old: Array<string> = []
	const neu: Array<string> = fileLines ? [...fileLines] : []
	if (fileLines)
		for (const g of computeGaps(hunks, fileLines.length))
			for (let n = g.from; n <= (g.to ?? fileLines.length) && n <= fileLines.length; n++) old[n + g.offset - 1] = fileLines[n - 1]
	for (const h of hunks)
		for (const l of h.lines) {
			if (l.oldNo !== null && l.kind !== 'add') old[l.oldNo - 1] = l.text
			if (l.newNo !== null && l.kind !== 'del' && !fileLines) neu[l.newNo - 1] = l.text
		}
	return { old: Array.from(old, (s) => s ?? ''), new: Array.from(neu, (s) => s ?? '') }
}

export interface Piece {
	start: number
	end: number
	kind: number // index in KINDS
	mark: number | null // index of the hidden or look-alike character marked here, drawn as before
}

/**
 * A line cut into what's drawn: runs of one kind, and each marked character (issue #223) whole and uncoloured. Tokens
 * that don't add up to the line (another version's tokens) are ignored, so the line is still drawn as written.
 */
export function pieces(text: string, tokens: LineTokens | null, marks: Array<{ start: number; end: number }>): Array<Piece> {
	let total = 0
	if (tokens) for (let i = 0; i < tokens.length; i += 2) total += tokens[i]
	const runs: Array<{ start: number; end: number; kind: number }> = []
	if (tokens && total === text.length) {
		let at = 0
		for (let i = 0; i < tokens.length; i += 2) {
			const end = at + tokens[i]
			if (end === at) continue
			const last = runs[runs.length - 1]
			if (last && last.kind === tokens[i + 1]) last.end = end
			else runs.push({ start: at, end, kind: tokens[i + 1] })
			at = end
		}
	} else if (text) runs.push({ start: 0, end: text.length, kind: 0 })
	const out: Array<Piece> = []
	let m = 0
	let at = 0 // a mark can run past the end of its token, so this carries across runs
	for (const r of runs) {
		while (at < r.end) {
			while (m < marks.length && marks[m].end <= at) m++
			const mk = marks[m]
			if (mk && mk.start <= at) {
				out.push({ start: at, end: mk.end, kind: 0, mark: m })
				at = mk.end
				m++
				continue
			}
			const end = mk && mk.start < r.end ? mk.start : r.end
			out.push({ start: at, end, kind: r.kind, mark: null })
			at = end
		}
	}
	return out
}

export type Segment = { kind: 'text'; text: string } | { kind: 'code'; lang: string | null; lines: Array<string> }

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/

/**
 * An AI answer cut into its prose and its fenced code blocks, so the code can be shown coloured and the prose exactly
 * as written. A block left open runs to the end. The line breaks next to a fence belong to it, so the prose around a
 * block doesn't gain blank lines.
 */
export function splitFences(text: string): Array<Segment> {
	const lines = text.replace(/\r\n?/g, '\n').split('\n')
	const out: Array<Segment> = []
	let prose: Array<string> = []
	const flush = (): void => {
		if (prose.some((l) => l.trim())) out.push({ kind: 'text', text: prose.join('\n').replace(/^\n+|\n+$/g, '') })
		prose = []
	}
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(lines[i])
		if (!open) {
			prose.push(lines[i])
			continue
		}
		flush()
		const code: Array<string> = []
		const close = open[1][0]
		const min = open[1].length
		for (i++; i < lines.length; i++) {
			const t = lines[i].trim()
			if (t.length >= min && [...t].every((c) => c === close)) break
			code.push(lines[i])
		}
		out.push({ kind: 'code', lang: open[2] || null, lines: code })
	}
	flush()
	return out
}
