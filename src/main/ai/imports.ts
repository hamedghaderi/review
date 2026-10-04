import { posix } from 'node:path'
import { git } from '../git.ts'
import type { ContextFact, FileSource } from './context.ts'

/**
 * Which files import each changed file, from the import lines of the head commit (Git objects only, never the
 * working tree). One `git grep` for the changed files' names, then each import line's target is resolved and compared
 * with the changed file's path: relative imports exactly, package-style imports (`@/lib/cart`, `App\Billing\Tax`,
 * `com.shop.Cart`, `app.billing.tax`, Go package paths) by their last path segments. It is a text match on common
 * import forms of JS/TS, Python, PHP, Java/Kotlin, Go, Ruby and C/C++: a form it misses means a missing importer,
 * never a wrong one. For deleted and renamed files the old path is checked too: an importer of a path that no longer
 * exists is a likely break.
 */
export interface FileImporters {
	fileKey: string
	path: string // the file's path at the head commit, or its old path when deleted
	importers: Array<string> // non-test files that import it
	tests: Array<string> // test files that import it
	stale: Array<string> // files that still import its old path (deleted or renamed away)
}

const MAX_LISTED = 8 // names per list in what the reviewer is told
const GREP_LIMIT = 8 * 1024 * 1024
const MAX_FILES = 200 // changed files whose importers are traced

// The line imports something; the target is pulled out below.
const IMPORT_LINE =
	/^\s*(import\b|export\b[^;]*\bfrom\b|\}\s*from\s|from\s+[\w.]+\s+import\b|use\s+[\w\\]|require(_relative)?\b|#\s*include\b|@import\b|load\b)|\brequire\s*\(|\bimport\s*\(/

const SKIP_DIRS = /(^|\/)(node_modules|vendor|bower_components|dist|build|out|coverage|target|\.next|\.nuxt|__pycache__|\.venv|venv)\//
const CODE =
	/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|pyi|rb|go|rs|java|kt|kts|scala|groovy|cs|php|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|dart|ex|exs|scss|sass|less)$/i
export const TEST_PATH =
	/(^|\/)(tests?|__tests__|specs?|fixtures?|__mocks__)\/|\.(test|spec)\.\w+$|_test\.(go|py)$|(^|\/)test_\w+\.py$|Tests?\.(php|java|kt|cs)$/
// Names that say nothing on their own: the folder names the module instead.
const INDEX_NAMES = new Set(['index', '__init__', 'mod', 'main', 'init'])

interface Target {
	fileKey: string
	path: string
	old: boolean // a path the change removes (deleted, or renamed away)
}

export async function findImporters(
	root: string,
	headSha: string,
	sources: Array<FileSource>,
	signal?: AbortSignal,
): Promise<Array<FileImporters>> {
	const targets: Array<Target> = []
	for (const { file } of sources.slice(0, MAX_FILES)) {
		if (file.newPath && CODE.test(file.newPath)) targets.push({ fileKey: file.key, path: file.newPath, old: false })
		if (file.oldPath && file.oldPath !== file.newPath && CODE.test(file.oldPath))
			targets.push({ fileKey: file.key, path: file.oldPath, old: true })
	}
	const words = [...new Set(targets.map((t) => moduleWord(t.path)).filter((w) => w.length >= 3))]
	if (!words.length) return []
	const r = await git(
		root,
		['grep', '-n', '-I', '-w', '-F', '-z', '--no-color', ...words.flatMap((w) => ['-e', w]), headSha, '--'],
		GREP_LIMIT,
		{ signal, timeoutMs: 30_000 },
	)
	if (r.code > 1 && !r.truncated) throw new Error(`git grep failed: ${r.stderr.trim()}`)
	const at = `${headSha}:`
	const found = new Map<Target, Set<string>>(targets.map((t) => [t, new Set()]))
	for (const rec of r.stdout.toString('utf8').split('\n')) {
		const [loc, , text] = rec.split('\0')
		if (!loc?.startsWith(at) || text === undefined || text.length > 400 || !IMPORT_LINE.test(text)) continue
		const importer = loc.slice(at.length)
		if (SKIP_DIRS.test(importer)) continue
		const specs = importSpecs(text)
		if (!specs.length) continue
		for (const t of targets) {
			if (importer === t.path) continue
			if (specs.some((s) => resolves(importer, s, t.path))) found.get(t)!.add(importer)
		}
	}
	const out: Array<FileImporters> = []
	for (const t of targets) {
		if (t.old) continue
		const all = [...found.get(t)!].sort()
		const stale = targets.filter((x) => x.old && x.fileKey === t.fileKey).flatMap((x) => [...found.get(x)!].filter((p) => !all.includes(p)))
		out.push(entry(t.fileKey, t.path, all, stale))
	}
	// Deleted files: only the importers of the path that is gone.
	for (const t of targets) {
		if (!t.old || out.some((o) => o.fileKey === t.fileKey)) continue
		out.push(entry(t.fileKey, t.path, [], [...found.get(t)!].sort()))
	}
	return out.filter((o) => o.importers.length || o.tests.length || o.stale.length)
}

function entry(fileKey: string, path: string, all: Array<string>, stale: Array<string>): FileImporters {
	return { fileKey, path, importers: all.filter((p) => !TEST_PATH.test(p)), tests: all.filter((p) => TEST_PATH.test(p)), stale }
}

/** What the reviewer is told: one fact per changed file, sent with the requests that carry that file. */
export function importFacts(list: Array<FileImporters>): Array<ContextFact> {
	const names = (xs: Array<string>): string =>
		xs.length > MAX_LISTED ? `${xs.slice(0, MAX_LISTED).join(', ')} and ${xs.length - MAX_LISTED} more` : xs.join(', ')
	return list.map((f) => {
		const lines = [`${f.path}:`]
		if (f.importers.length)
			lines.push(`- imported by ${f.importers.length} file${f.importers.length === 1 ? '' : 's'}: ${names(f.importers)}`)
		if (f.tests.length) lines.push(`- imported by ${f.tests.length} test file${f.tests.length === 1 ? '' : 's'}: ${names(f.tests)}`)
		if (f.stale.length)
			lines.push(
				`- STILL IMPORTED at the path this change removes, by ${f.stale.length} file${f.stale.length === 1 ? '' : 's'}: ${names(f.stale)}`,
			)
		return { kind: 'structure' as const, title: 'Who imports this file', text: lines.join('\n'), fileKeys: [f.fileKey] }
	})
}

export function importSummary(list: Array<FileImporters>): string {
	const importers = new Set(list.flatMap((f) => f.importers))
	const tests = new Set(list.flatMap((f) => f.tests))
	const stale = list.filter((f) => f.stale.length).length
	return `${list.length} changed file${list.length === 1 ? ' is' : 's are'} imported by ${importers.size} other file${importers.size === 1 ? '' : 's'} and ${tests.size} test${tests.size === 1 ? '' : 's'}${stale ? `; ${stale} removed or renamed file${stale === 1 ? ' is' : 's are'} still imported at the old path` : ''}.`
}

/** The word an import of this file must contain: its name, or its folder's for index-like files. */
function moduleWord(path: string): string {
	const { dir, name } = posix.parse(path)
	return INDEX_NAMES.has(name) && dir ? posix.basename(dir) : name
}

/** The module references on one import line, as path segments plus whether they are relative (and how many levels up). */
export interface Spec {
	segs: Array<string>
	relative: string | null // the raw relative path ('./x', '../y') for quoted imports; null otherwise
	pyUp: number // Python relative import: number of leading dots
	pkg?: boolean // a quoted bare name without extension ('react'): a package, never a sibling file
}

export function importSpecs(line: string): Array<Spec> {
	const out: Array<Spec> = []
	const quoted = line.match(/(['"])([^'"\s]+)\1/g) ?? []
	for (const q of quoted) {
		const s = q.slice(1, -1)
		if (s.startsWith('.')) out.push({ segs: [], relative: s, pyUp: 0 })
		else
			out.push({
				segs: splitSegs(s.replace(/^(@\/|~\/|#\/|\$\/)/, '')),
				relative: null,
				pyUp: 0,
				pkg: !s.includes('/') && !/\.\w+$/.test(s),
			})
	}
	if (quoted.length) return out
	// Python: from .x.y import a, b / from x.y import a / import x.y as z
	const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line)
	if (from) {
		const up = from[1].length
		const base = from[2] ? from[2].split('.') : []
		out.push({ segs: base, relative: null, pyUp: up })
		for (const name of from[3].replace(/[()]/g, '').split(',')) {
			const n = name.trim().split(/\s+/)[0]
			if (/^\w+$/.test(n)) out.push({ segs: [...base, n], relative: null, pyUp: up })
		}
		return out
	}
	const imp = /^\s*import\s+([\w.]+)/.exec(line) // Python, Java, Kotlin, Scala
	if (imp) return [{ segs: imp[1].split('.').filter((s) => s !== '*'), relative: null, pyUp: 0 }]
	const use = /^\s*use\s+\\?([\w\\]+)/.exec(line) // PHP
	if (use) return [{ segs: use[1].split('\\'), relative: null, pyUp: 0 }]
	return out
}

function splitSegs(s: string): Array<string> {
	return s.split('/').filter((x) => x && x !== '.')
}

function stripExt(p: string): string {
	return p.replace(/\.(d\.ts|[a-z0-9]+)$/i, '')
}

/** Does `spec`, imported from `importer`, refer to the file at `target`? */
export function resolves(importer: string, spec: Spec, target: string): boolean {
	const t = stripExt(target)
	const tDir = posix.dirname(target)
	const index = INDEX_NAMES.has(posix.basename(t))
	const same = (p: string): boolean => {
		const x = stripExt(p)
		return x === t || (index && x === tDir)
	}
	if (spec.relative !== null) return same(posix.normalize(posix.join(posix.dirname(importer), spec.relative)))
	if (spec.pyUp > 0) {
		let dir = posix.dirname(importer)
		for (let i = 1; i < spec.pyUp; i++) dir = posix.dirname(dir)
		return same(posix.join(dir, ...spec.segs))
	}
	const segs = spec.segs.map((s) => stripExt(s).toLowerCase())
	if (!segs.length) return false
	const tSegs = t.toLowerCase().split('/')
	const dirSegs = tDir.toLowerCase().split('/')
	const endsWith = (whole: Array<string>, part: Array<string>): boolean =>
		part.length <= whole.length && part.every((s, i) => whole[whole.length - part.length + i] === s)
	// A package-style import names the file by its last segments: two are needed, so `lodash` or `os` match nothing.
	if (segs.length >= 2 && endsWith(tSegs, segs)) return true
	if (index && segs.length >= 2 && endsWith(dirSegs, segs)) return true
	// Go imports a package (a folder) by a path that ends with the folder's own path.
	if (/\.go$/.test(importer) && /\.go$/.test(target) && dirSegs.length >= 2 && endsWith(segs, dirSegs.slice(-2))) return true
	// A one-word import of a sibling module (Python `import tax`, C `#include "tax.h"`).
	return !spec.pkg && segs.length === 1 && posix.dirname(importer) === tDir && segs[0] === posix.basename(t).toLowerCase()
}
