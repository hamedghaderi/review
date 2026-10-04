import { git } from '../git.ts'
import type { FileSource } from './context.ts'
import { findImporters, type FileImporters } from './imports.ts'

/**
 * Related code for the AI reviewer: where names the change uses are defined, and where names the change defines,
 * changes or removes are used. Found with `git grep` on the head commit (the object database, never the working
 * tree), so it is a text search: a match can be a different thing with the same name, and the prompt says so.
 * Language-agnostic by design: the patterns cover the common definition forms of JS/TS, Python, Go, Rust, Java,
 * Kotlin, C#, PHP and Ruby, and anything they miss simply isn't added.
 */
export interface RelatedSnippet {
	path: string
	start: number // head line numbers, inclusive
	end: number
	lines: Array<string>
	reasons: Array<string>
	fileKeys: Set<string> // the changed files it is related to; it is sent only in requests that carry one of them
	priority: number // 0 first: callers of changed signatures and removed names; 1 definitions; 2 other callers
}

export interface RelatedResult {
	snippets: Array<RelatedSnippet>
	symbols: number // names searched for
	notes: Array<string> // e.g. names skipped as too common
	importers: Array<FileImporters> // which files import each changed file
}

const MAX_USED = 60
const MAX_DEFINED = 40
const TOO_COMMON = 80 // matches across the repository; beyond this a name tells the reviewer nothing
const DEFS_PER_NAME = 2
const USES_PER_NAME = 6
const DEF_LINES = 50
const USE_CONTEXT = 3
const MAX_FILES = 80
const FILE_LIMIT = 2 * 1024 * 1024
const GREP_LIMIT = 8 * 1024 * 1024

const IDENT = /[A-Za-z_$][\w$]*/g
// An import names a thing without using it, so it tells the reviewer nothing about how it is called.
const IMPORT = /^\s*(import\b|export\s*\{|export\s+\*|from\s+\S+\s+import\b|use\s|using\s|require\b|#include\b|[\w{},\s]+=\s*require\()/

// Each pattern captures the defined name in group 1.
const DEFINITIONS: Array<RegExp> = [
	// function / def / fn / func (with a Go receiver) / fun / class / interface / trait / struct / enum / type / record…
	/\b(?:function\*?|def|fn|func|fun|sub|class|interface|trait|struct|enum|type|record|module|protocol|object|impl)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
	// const foo = (…) => / = async function / = x =>
	/\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
	// methods: name(args) {  — with optional modifiers, generics and a return type
	/^\s*(?:(?:public|private|protected|internal|static|async|override|abstract|final|virtual|export|default|readonly|open|suspend|synchronized|get|set)\s+)*(?:[\w$<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+|->\s*[^{;]+|throws\s+[^{;]+)?\s*\{\s*$/,
]

const NOT_NAMES = new Set(
	`if else for while do switch case catch try finally return throw new delete typeof instanceof in of with yield await async
	function def fn func fun class interface struct enum type const let var val import export from default extends implements
	super this self cls true false null nil none undefined void static public private protected get set constructor init
	print println printf len str int float bool list dict map filter reduce push pop shift then catch finally resolve reject
	console log warn error info debug require module exports string number boolean object array promise date json math
	String Number Boolean Object Array Promise Map Set WeakMap Error Date JSON Math RegExp Symbol React Fragment useState
	useEffect useMemo useCallback useRef describe it test expect assert should beforeEach afterEach toBe toEqual equal`.split(/\s+/),
)

function definedName(text: string): string | null {
	for (const re of DEFINITIONS) {
		const m = re.exec(text)
		if (m && !NOT_NAMES.has(m[1])) return m[1]
	}
	return null
}

function goodName(n: string): boolean {
	return n.length >= 3 && !NOT_NAMES.has(n)
}

/** Names the changed lines use: calls, `new X`, and capitalised names (types, classes, enums). */
function usedNames(text: string): Array<string> {
	const out: Array<string> = []
	const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$|#.*$/, '') // skip strings and line comments
	for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) out.push(m[1])
	for (const m of code.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) out.push(m[1])
	for (const m of code.matchAll(/\b([A-Z][a-z][\w$]*)\b/g)) out.push(m[1])
	return out.filter(goodName)
}

type DefinedKind = 'signature' | 'removed' | 'added' | 'body'

interface Wanted {
	used: Map<string, { count: number; fileKeys: Set<string> }>
	defined: Map<string, { kind: DefinedKind; fileKeys: Set<string> }>
	ownDefs: Map<string, Set<string>> // name → changed files that define it on added lines (their definitions are in the excerpts)
}

const KIND_RANK: Record<DefinedKind, number> = { signature: 0, removed: 0, added: 2, body: 2 }

/** What to look for, from the changed lines of every text diff in scope. */
export function wantedNames(sources: Array<FileSource>): Wanted {
	const used: Wanted['used'] = new Map()
	const defined: Wanted['defined'] = new Map()
	const ownDefs: Wanted['ownDefs'] = new Map()
	const define = (name: string, kind: DefinedKind, key: string): void => {
		const cur = defined.get(name)
		if (!cur) defined.set(name, { kind, fileKeys: new Set([key]) })
		else {
			cur.fileKeys.add(key)
			if (KIND_RANK[kind] < KIND_RANK[cur.kind]) cur.kind = kind
		}
	}
	for (const { file, patch } of sources) {
		if (patch.kind !== 'text') continue
		const added = new Map<string, Set<string>>() // name → its definition lines, whitespace-normalised
		const removed = new Map<string, Set<string>>()
		for (const h of patch.hunks) {
			// The function a changed line sits in: the nearest definition above it in the hunk, else git's hunk header.
			let enclosing = definedName(h.section)
			for (const l of h.lines) {
				const d = definedName(l.text)
				if (l.kind === 'ctx') {
					if (d) enclosing = d
					continue
				}
				if (d) {
					const m = l.kind === 'add' ? added : removed
					m.set(d, (m.get(d) ?? new Set()).add(l.text.replace(/\s+/g, ' ').trim()))
				} else if (enclosing) define(enclosing, 'body', file.key)
				if (l.kind === 'add') {
					if (d) enclosing = d
					for (const n of usedNames(l.text)) {
						const u = used.get(n) ?? { count: 0, fileKeys: new Set() }
						u.count++
						u.fileKeys.add(file.key)
						used.set(n, u)
					}
				}
			}
		}
		for (const [n, texts] of added) {
			const old = removed.get(n)
			// Removed and re-added with the same text is a move, not an edit to the signature.
			define(n, !old ? 'added' : [...texts].every((t) => old.has(t)) ? 'body' : 'signature', file.key)
			ownDefs.set(n, (ownDefs.get(n) ?? new Set()).add(file.key))
		}
		for (const n of removed.keys()) if (!added.has(n)) define(n, 'removed', file.key)
	}
	// A name defined by the change itself doesn't need its definition looked up.
	for (const n of ownDefs.keys()) used.delete(n)
	return { used, defined, ownDefs }
}

interface Hit {
	path: string
	line: number
	text: string
}

/**
 * Searches the head commit for the definitions and uses of the change's names and cuts reference snippets from the
 * matching files. Snippets that repeat lines already in a request's excerpts are dropped when requests are packed.
 */
export async function findRelated(root: string, headSha: string, sources: Array<FileSource>, signal?: AbortSignal): Promise<RelatedResult> {
	const want = wantedNames(sources)
	const used = [...want.used.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_USED)
	const defined = [...want.defined.entries()].sort((a, b) => KIND_RANK[a[1].kind] - KIND_RANK[b[1].kind]).slice(0, MAX_DEFINED)
	const names = [...new Set([...used.map(([n]) => n), ...defined.map(([n]) => n)])]
	const files = new Map<string, Array<string> | null>()
	const read = async (path: string): Promise<Array<string> | null> => {
		if (files.has(path)) return files.get(path)!
		if (files.size >= MAX_FILES) return null
		const b = await git(root, ['cat-file', 'blob', `${headSha}:${path}`], FILE_LIMIT, { signal })
		const lines =
			b.code === 0 && !b.truncated
				? b.stdout
						.toString('utf8')
						.split('\n')
						.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
				: null
		files.set(path, lines)
		return lines
	}
	const notes: Array<string> = []
	let importers: Array<FileImporters> = []
	try {
		importers = await findImporters(root, headSha, sources, signal)
	} catch (e) {
		if (signal?.aborted) throw e
		notes.push(`Imports could not be traced: ${e instanceof Error ? e.message : String(e)}`)
	}
	// Changed file → every file that imports it (at its current or old path).
	const importedBy = new Map(importers.map((f) => [f.fileKey, new Set([...f.importers, ...f.tests, ...f.stale])]))
	if (!names.length) return { snippets: await peerFiles(root, headSha, sources, read, signal), symbols: 0, notes, importers }
	const r = await git(
		root,
		['grep', '-n', '-I', '-w', '-F', '-z', '--no-color', ...names.flatMap((n) => ['-e', n]), headSha, '--'],
		GREP_LIMIT,
		{
			signal,
			timeoutMs: 30_000,
		},
	)
	if (r.code > 1 && !r.truncated) throw new Error(`git grep failed: ${r.stderr.trim()}`)
	if (r.truncated) notes.push('The related-code search stopped early: too many matches.')
	const prefix = `${headSha}:`
	const byName = new Map<string, Array<Hit>>()
	const wanted = new Set(names)
	for (const rec of r.stdout.toString('utf8').split('\n')) {
		const [loc, no, text] = rec.split('\0')
		if (!loc?.startsWith(prefix) || text === undefined) continue
		const path = loc.slice(prefix.length)
		if (skipPath(path) || text.length > 400) continue
		for (const n of new Set(text.match(IDENT) ?? [])) {
			if (!wanted.has(n)) continue
			const list = byName.get(n) ?? []
			list.push({ path, line: Number(no), text })
			byName.set(n, list)
		}
	}
	const common = names.filter((n) => (byName.get(n)?.length ?? 0) > TOO_COMMON)
	if (common.length) notes.push(`Not looked up, too common to be useful: ${common.slice(0, 8).join(', ')}${common.length > 8 ? '…' : ''}.`)

	// Candidate windows before reading any file.
	type Pick = {
		path: string
		line: number
		def: boolean
		reason: string
		fileKeys: Set<string>
		priority: number
		hits: number
		imports: boolean // the file imports a changed file this name belongs to, so it is very likely the same thing
	}
	const picks: Array<Pick> = []
	for (const [n, u] of used) {
		const hits = byName.get(n) ?? []
		if (hits.length > TOO_COMMON) continue
		for (const h of hits.filter((x) => definedName(x.text) === n).slice(0, DEFS_PER_NAME))
			picks.push({
				...h,
				def: true,
				reason: `definition of \`${n}\`, which the change uses`,
				fileKeys: u.fileKeys,
				priority: 1,
				hits: hits.length,
				imports: false,
			})
	}
	for (const [n, d] of defined) {
		const hits = byName.get(n) ?? []
		if (hits.length > TOO_COMMON) continue
		const uses = hits.filter((x) => definedName(x.text) !== n && !IMPORT.test(x.text))
		// Uses in other files first: those are the callers a change to `n` can break.
		const own = new Set([...d.fileKeys])
		uses.sort((a, b) => Number(own.has(a.path)) - Number(own.has(b.path)))
		const why =
			d.kind === 'removed'
				? `use of \`${n}\`, which the change removes or renames`
				: d.kind === 'signature'
					? `use of \`${n}\`, whose definition the change edits`
					: d.kind === 'body'
						? `use of \`${n}\`, whose body the change edits`
						: `use of \`${n}\`, which the change adds`
		for (const h of uses.slice(0, USES_PER_NAME))
			picks.push({
				...h,
				def: false,
				reason: why,
				fileKeys: d.fileKeys,
				priority: KIND_RANK[d.kind],
				hits: hits.length,
				imports: [...d.fileKeys].some((k) => importedBy.get(k)?.has(h.path)),
			})
	}

	const raw: Array<RelatedSnippet> = []
	// Most useful first; within a priority, uses in files that import the changed file, then rarer names (a name with
	// few matches is more likely the same thing).
	for (const p of picks.sort((a, b) => a.priority - b.priority || Number(b.imports) - Number(a.imports) || a.hits - b.hits)) {
		const lines = await read(p.path)
		if (!lines) continue
		const [start, end] = p.def
			? definitionWindow(lines, p.line)
			: [Math.max(1, p.line - USE_CONTEXT), Math.min(lines.length, p.line + USE_CONTEXT)]
		const inside = p.def ? null : enclosingDefinition(lines, p.line)
		raw.push({
			path: p.path,
			start,
			end,
			lines: lines.slice(start - 1, end),
			reasons: [
				`${p.reason}${inside ? ` (in \`${inside.name}\`, line ${inside.line})` : ''}${p.imports ? '; this file imports the changed file' : ''}`,
			],
			fileKeys: new Set(p.fileKeys),
			priority: p.priority,
		})
	}
	raw.push(...(await peerFiles(root, headSha, sources, read, signal)))
	return { snippets: mergeOverlapping(raw), symbols: names.length - common.length, notes, importers }
}

const PEER_FILES = 2 // per added file
const PEER_ADDED = 4 // added files that get peers
const PEER_LINES = 80

/**
 * For files the change adds: the start of up to two existing files of the same kind in the same folder, so the reviewer
 * can see how this codebase usually writes such a file (how a validation rule reports its error, how a test is set
 * up). Same extension, and the most similar name ending first ("…Test.php" next to a new test, "…Request.php" next to
 * a new request); files the change touches are not peers.
 */
async function peerFiles(
	root: string,
	headSha: string,
	sources: Array<FileSource>,
	read: (path: string) => Promise<Array<string> | null>,
	signal?: AbortSignal,
): Promise<Array<RelatedSnippet>> {
	const changed = new Set(sources.flatMap((s) => [s.file.newPath, s.file.oldPath].filter((p): p is string => !!p)))
	const added = sources.filter((s) => s.file.status === 'added' && s.file.newPath && !skipPath(s.file.newPath)).slice(0, PEER_ADDED)
	const out: Array<RelatedSnippet> = []
	for (const s of added) {
		const path = s.file.newPath!
		const slash = path.lastIndexOf('/')
		const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
		const name = path.slice(slash + 1)
		const ext = name.includes('.') ? name.slice(name.indexOf('.')) : ''
		const r = await git(root, ['ls-tree', '--name-only', '-z', `${headSha}:${dir}`], 1024 * 1024, { signal })
		if (r.code !== 0) continue
		const peers = r.stdout
			.toString('utf8')
			.split('\0')
			.filter((n) => n && n !== name && n.endsWith(ext) && !changed.has(dir + n) && !skipPath(dir + n))
			.sort((a, b) => sharedEnding(b, name) - sharedEnding(a, name) || a.localeCompare(b))
			.slice(0, PEER_FILES)
		for (const peer of peers) {
			const lines = await read(dir + peer)
			if (!lines) continue
			const end = Math.min(lines.length, PEER_LINES)
			out.push({
				path: dir + peer,
				start: 1,
				end,
				lines: lines.slice(0, end),
				reasons: [
					`peer of \`${name}\` (added by the change): an existing file of the same kind in the same folder${end < lines.length ? `, first ${end} of ${lines.length} lines` : ''}`,
				],
				fileKeys: new Set([s.file.key]),
				priority: 2,
			})
		}
	}
	return out
}

/** Length of the common ending of two file names, e.g. 8 for "AbcTest.php" and "XyzTest.php" ("Test.php"). */
function sharedEnding(a: string, b: string): number {
	let n = 0
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
	return n
}

/** A definition and its body: to the closing brace, or while the indentation is deeper (Python, Ruby-ish). */
function definitionWindow(lines: Array<string>, at: number): [number, number] {
	let start = at
	while (start > 1 && at - start < 3 && /^\s*(@|\/\/\/?|#\[|\/\*\*|\*|""")/.test(lines[start - 2])) start-- // decorators, doc comments
	const indent = (s: string): number => s.length - s.trimStart().length
	const base = indent(lines[at - 1])
	let depth = 0
	let opened = false
	let end = at
	for (let n = at; n <= Math.min(lines.length, at + DEF_LINES - 1); n++) {
		const t = lines[n - 1]
		end = n
		for (const ch of t.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
			if (ch === '{') {
				depth++
				opened = true
			} else if (ch === '}') depth--
		}
		if (opened && depth <= 0) break
		if (!opened && n > at && t.trim() && indent(t) <= base) {
			end = n - 1
			break
		}
		if (!opened && n === at && /;\s*$/.test(t)) break // a one-line declaration
	}
	return [start, Math.max(end, at)]
}

function enclosingDefinition(lines: Array<string>, at: number): { name: string; line: number } | null {
	const own = lines[at - 1]
	const indent = (s: string): number => s.length - s.trimStart().length
	for (let n = at - 1; n >= Math.max(1, at - 300); n--) {
		const t = lines[n - 1]
		if (!t.trim() || indent(t) >= indent(own)) continue
		const name = definedName(t)
		if (name) return { name, line: n }
	}
	return null
}

function mergeOverlapping(xs: Array<RelatedSnippet>): Array<RelatedSnippet> {
	const out: Array<RelatedSnippet> = []
	for (const s of xs) {
		const o = out.find((x) => x.path === s.path && x.start <= s.end + 1 && s.start <= x.end + 1)
		if (!o) {
			out.push(s)
			continue
		}
		const lines = new Map<number, string>()
		o.lines.forEach((l, i) => lines.set(o.start + i, l))
		s.lines.forEach((l, i) => lines.set(s.start + i, l))
		o.start = Math.min(o.start, s.start)
		o.end = Math.max(o.end, s.end)
		o.lines = Array.from({ length: o.end - o.start + 1 }, (_, i) => lines.get(o.start + i) ?? '')
		for (const r of s.reasons) if (!o.reasons.includes(r)) o.reasons.push(r)
		for (const k of s.fileKeys) o.fileKeys.add(k)
		o.priority = Math.min(o.priority, s.priority)
	}
	return out
}

const SKIP_DIRS = /(^|\/)(node_modules|vendor|bower_components|dist|build|out|coverage|target|\.next|\.nuxt|__pycache__|\.venv|venv)\//
const SKIP_FILES =
	/(\.min\.(js|css)|\.map|\.snap|\.svg|\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/

// Only source files count as definitions or uses; a name in a README, a manifest or config is prose, not a caller.
const CODE =
	/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|pyi|rb|go|rs|java|kt|kts|scala|groovy|cs|fs|vb|php|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|dart|ex|exs|erl|hrl|hs|clj|cljs|lua|pl|pm|r|jl|sh|bash|zsh|ps1|sql)$/i

function skipPath(p: string): boolean {
	return !CODE.test(p) || SKIP_DIRS.test(p) || SKIP_FILES.test(p)
}
