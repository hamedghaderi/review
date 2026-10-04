import semver from 'semver'
import { git } from '../git.ts'
import type { FileSource } from './context.ts'

/**
 * Dependency facts for changes to npm manifests and lock files, computed in code so the reviewer doesn't have to
 * guess (or ask) whether a forced or upgraded version is inside what its dependents declare. Everything comes from
 * package.json and package-lock.json (lockfileVersion 2 or 3) at the base and head commits. A range check shows
 * declared support only; it can't say whether the code runs, and the text says so.
 */
export interface DepsResult {
	text: string | null
	fileKeys: Array<string> // the manifest and lock files it belongs to
	packages: number // changed packages analysed
	outOfRange: number // dependents whose declared range excludes what they get
	notes: Array<string>
}

const MAX_PACKAGES = 25
const MAX_LISTED = 12 // out-of-range dependents listed per package
const TEXT_LIMIT = 12_000
const LOCK_LIMIT = 64 * 1024 * 1024
const MANIFEST = /(^|\/)package\.json$/
const LOCK = /(^|\/)(package-lock|npm-shrinkwrap)\.json$/
const OTHER_LOCK = /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

interface LockEntry {
	version?: string
	name?: string
	link?: boolean
	engines?: Record<string, string> | Array<string>
	dependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
type Packages = Record<string, LockEntry>
interface Manifest {
	name?: string
	engines?: { node?: string }
	volta?: { node?: string }
	overrides?: Record<string, unknown>
	resolutions?: Record<string, unknown>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

export async function dependencyFacts(
	root: string,
	baseSha: string,
	headSha: string,
	sources: Array<FileSource>,
	signal?: AbortSignal,
): Promise<DepsResult | null> {
	const touched = sources
		.map((s) => s.file)
		.filter((f) => [f.newPath, f.oldPath].some((p) => p && (MANIFEST.test(p) || LOCK.test(p) || OTHER_LOCK.test(p))))
	if (!touched.length) return null
	const notes: Array<string> = []
	const dirs = [...new Set(touched.map((f) => dirOf((f.newPath ?? f.oldPath)!)))]
	const read = async (sha: string, path: string): Promise<string | null> => {
		const r = await git(root, ['cat-file', 'blob', `${sha}:${path}`], LOCK_LIMIT, { signal })
		return r.code === 0 && !r.truncated ? r.stdout.toString('utf8') : null
	}
	const json = <T>(text: string | null): T | null => {
		if (!text) return null
		try {
			return JSON.parse(text) as T
		} catch {
			return null
		}
	}
	const sections: Array<string> = []
	let packages = 0
	let outOfRange = 0
	for (const dir of dirs.slice(0, 3)) {
		const at = (name: string) => (dir ? `${dir}/${name}` : name)
		const headManifest = json<Manifest>(await read(headSha, at('package.json')))
		const baseManifest = json<Manifest>(await read(baseSha, at('package.json')))
		// A workspace package has no lock of its own; the repository root's lock covers it.
		let lockPath = at('package-lock.json')
		let headLockText = await read(headSha, lockPath)
		if (!headLockText) headLockText = await read(headSha, (lockPath = at('npm-shrinkwrap.json')))
		if (!headLockText && dir) headLockText = await read(headSha, (lockPath = 'package-lock.json'))
		const headLock = json<{ lockfileVersion?: number; packages?: Packages }>(headLockText)
		const baseLock = json<{ packages?: Packages }>(await read(baseSha, lockPath))
		if (!headLock?.packages) {
			notes.push(
				headLockText
					? `${lockPath} is not lockfileVersion 2 or 3, so dependents were not analysed.`
					: `No package-lock.json for ${at('package.json')}${touched.some((f) => OTHER_LOCK.test(f.newPath ?? '')) ? ' (yarn, pnpm and bun locks are not analysed yet)' : ''}, so dependents were not analysed.`,
			)
			continue
		}
		const r = analyse(
			headLock.packages,
			baseLock?.packages ?? null,
			headManifest,
			baseManifest,
			await projectNode(read, headSha, dir, headManifest),
		)
		packages += r.packages
		outOfRange += r.outOfRange
		if (r.text) sections.push(`${dir ? `${dir}/` : ''}package.json with ${lockPath}:\n${r.text}`)
	}
	let text = sections.length
		? `Computed by the app with npm's semver rules from package.json and the lock file at the base and head commits. A range check shows what each package declares it supports, not whether the code runs.\n\n${sections.join('\n\n')}`
		: null
	if (text && text.length > TEXT_LIMIT) text = `${text.slice(0, TEXT_LIMIT)}\n… (cut at ${TEXT_LIMIT.toLocaleString()} characters)`
	return { text, fileKeys: touched.map((f) => f.key), packages, outOfRange, notes }
}

function dirOf(p: string): string {
	const i = p.lastIndexOf('/')
	return i < 0 ? '' : p.slice(0, i)
}

/** The project's Node versions: engines.node, else volta.node, else .nvmrc / .node-version. */
async function projectNode(
	read: (sha: string, path: string) => Promise<string | null>,
	sha: string,
	dir: string,
	m: Manifest | null,
): Promise<{ range: string; source: string; lowest: string } | null> {
	const tries: Array<[string | null | undefined, string]> = [
		[m?.engines?.node, 'engines.node in package.json'],
		[m?.volta?.node, 'volta.node in package.json'],
	]
	for (const [range, source] of tries) {
		const lowest = range && semver.validRange(range) ? semver.minVersion(range)?.version : null
		if (range && lowest) return { range, source, lowest }
	}
	for (const f of ['.nvmrc', '.node-version']) {
		const t = (await read(sha, dir ? `${dir}/${f}` : f)) ?? (dir ? await read(sha, f) : null)
		const v = t && semver.coerce(t.trim().replace(/^v/, ''))
		if (v) return { range: t!.trim(), source: f, lowest: v.version }
	}
	return null
}

function nameOf(key: string): string | null {
	const i = key.lastIndexOf('node_modules/')
	return i < 0 ? null : key.slice(i + 'node_modules/'.length)
}

function versions(pkgs: Packages): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>()
	for (const [k, e] of Object.entries(pkgs)) {
		const n = nameOf(k)
		if (!n || e.link || !e.version) continue
		out.set(n, (out.get(n) ?? new Set()).add(e.version))
	}
	return out
}

/** The copy of `name` that the package at `from` gets: npm looks in its own node_modules, then each parent's. */
export function resolveInstalled(pkgs: Packages, from: string, name: string): string | null {
	let base = from
	for (;;) {
		const key = `${base ? `${base}/` : ''}node_modules/${name}`
		if (pkgs[key] && !pkgs[key].link) return key
		if (!base) return null
		const i = base.lastIndexOf('/node_modules/')
		base = i >= 0 ? base.slice(0, i) : ''
	}
}

/** Top-level names in npm `overrides` (nested too) and yarn `resolutions` ("**\/name", "a/name"). */
function forcedNames(m: Manifest | null): Map<string, string> {
	const out = new Map<string, string>()
	const walk = (o: Record<string, unknown>): void => {
		for (const [k, v] of Object.entries(o)) {
			if (k === '.') continue // the parent's own version, read below
			const name = k.replace(/@[^@/]*$/, '') || k // "foo@1" → foo; "@scope/foo" stays
			if (typeof v === 'string') out.set(name, v)
			else if (v && typeof v === 'object') {
				const self = (v as Record<string, unknown>)['.']
				if (typeof self === 'string') out.set(name, self)
				walk(v as Record<string, unknown>)
			}
		}
	}
	if (m?.overrides) walk(m.overrides)
	for (const [k, v] of Object.entries(m?.resolutions ?? {}))
		if (typeof v === 'string')
			out.set(
				k
					.split('/')
					.filter((x) => x !== '**')
					.slice(-1)[0] ?? k,
				v,
			)
	return out
}

function byVersion(a: string, b: string): number {
	return semver.valid(a, true) && semver.valid(b, true) ? semver.compareLoose(a, b) : a.localeCompare(b)
}

function nodeRange(e: LockEntry): string | null {
	const n = Array.isArray(e.engines) ? e.engines.find((x) => x.startsWith('node'))?.replace(/^node\s*/, '') : e.engines?.node
	return typeof n === 'string' && n.trim() ? n.trim() : null
}

function analyse(
	head: Packages,
	base: Packages | null,
	headManifest: Manifest | null,
	baseManifest: Manifest | null,
	node: { range: string; source: string; lowest: string } | null,
): { text: string | null; packages: number; outOfRange: number } {
	const now = versions(head)
	const before = base ? versions(base) : new Map<string, Set<string>>()
	const forced = forcedNames(headManifest)
	const forcedBefore = forcedNames(baseManifest)
	const manifestChanged = new Set<string>()
	for (const f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const)
		for (const n of new Set([...Object.keys(headManifest?.[f] ?? {}), ...Object.keys(baseManifest?.[f] ?? {})]))
			if (headManifest?.[f]?.[n] !== baseManifest?.[f]?.[n]) manifestChanged.add(n)
	for (const n of new Set([...forced.keys(), ...forcedBefore.keys()])) if (forced.get(n) !== forcedBefore.get(n)) manifestChanged.add(n)

	const changed = [...now.keys()].filter((n) => {
		const a = [...(before.get(n) ?? [])].sort().join()
		const b = [...now.get(n)!].sort().join()
		return a !== b && (base !== null || manifestChanged.has(n))
	})
	const major = (n: string) => {
		const majors = (s: Set<string> | undefined) => new Set([...(s ?? [])].map((v) => (semver.valid(v, true) ? semver.major(v, true) : v)))
		const a = majors(before.get(n))
		return [...majors(now.get(n))].some((m) => !a.has(m))
	}
	// Forced and explicitly changed names first, then new major versions. Minor and patch bumps that only show up in the
	// lock file are counted, not listed: they don't change what a dependent can rely on.
	const rank = (n: string) => (forced.has(n) && forced.get(n) !== forcedBefore.get(n) ? 0 : manifestChanged.has(n) ? 1 : major(n) ? 2 : 3)
	const list = changed.filter((n) => rank(n) < 3).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
	const shown = list.slice(0, MAX_PACKAGES)
	const lines: Array<string> = []
	if (node) lines.push(`Project Node versions: "${node.range}" (${node.source}); lowest allowed ${node.lowest}.`)
	let outOfRange = 0
	for (const n of shown) {
		// Only the copies that changed; nested copies that stayed put are named separately.
		const old = before.get(n) ?? new Set<string>()
		const cur = now.get(n)!
		const kept = [...cur].filter((v) => old.has(v)).sort(byVersion)
		const was =
			[...old]
				.filter((v) => !cur.has(v))
				.sort(byVersion)
				.join(', ') || 'not installed'
		const is =
			([...cur]
				.filter((v) => !old.has(v))
				.sort(byVersion)
				.join(', ') || 'removed') + (kept.length ? `; ${kept.join(', ')} unchanged` : '')
		const why = forced.has(n)
			? ` (forced by ${headManifest?.overrides ? '"overrides"' : '"resolutions"'}: "${forced.get(n)}")`
			: manifestChanged.has(n)
				? ' (changed in package.json)'
				: ''
		lines.push(`- ${n}: ${was} → ${is}${why}`)
		const engines = new Set(
			Object.entries(head)
				.filter(([k]) => nameOf(k) === n)
				.map(([, e]) => nodeRange(e))
				.filter((x): x is string => !!x),
		)
		for (const r of engines) {
			const verdict =
				node && semver.validRange(r)
					? semver.satisfies(node.lowest, r)
						? `includes the project's lowest allowed Node ${node.lowest}`
						: `does NOT include the project's lowest allowed Node ${node.lowest}`
					: node
						? 'not a range the app can check'
						: 'the project declares no Node version to compare with'
			lines.push(`  requires Node "${r}": ${verdict}`)
		}
		const inside: Array<string> = []
		const outside: Array<string> = []
		const unknown: Array<string> = []
		for (const [k, e] of Object.entries(head)) {
			if (e.link) continue
			for (const field of DEP_FIELDS) {
				const range = e[field]?.[n]
				if (range === undefined) continue
				const who =
					k === '' ? `${headManifest?.name ?? 'this project'} (the project itself)` : `${nameOf(k) ?? k} ${e.version ?? ''}`.trim()
				const optionalPeer = field === 'peerDependencies' && e.peerDependenciesMeta?.[n]?.optional
				const where = resolveInstalled(head, k, n)
				const got = where ? head[where].version : null
				const label = `${who} (${field === 'dependencies' ? 'dependency' : field === 'optionalDependencies' ? 'optional dependency' : optionalPeer ? 'optional peer' : 'peer'} "${range}")`
				if (!got) {
					if (field === 'dependencies') unknown.push(`${label} gets no installed copy`)
					continue
				}
				if (!semver.validRange(range, { loose: true })) unknown.push(`${label}: not a version range`)
				else if (semver.satisfies(got, range, { loose: true, includePrerelease: true })) inside.push(who)
				else outside.push(`${label} gets ${got}`)
			}
		}
		outOfRange += outside.length
		if (outside.length) {
			lines.push(`  dependents whose declared range does NOT include the version they get (${outside.length}):`)
			for (const o of outside.slice(0, MAX_LISTED)) lines.push(`    ${o}`)
			if (outside.length > MAX_LISTED) lines.push(`    … and ${outside.length - MAX_LISTED} more`)
		}
		if (inside.length)
			lines.push(
				`  ${outside.length ? 'other ' : ''}dependents whose declared range includes it: ${inside.length} (${inside.slice(0, 6).join(', ')}${inside.length > 6 ? ', …' : ''})`,
			)
		if (!inside.length && !outside.length) lines.push('  no package in the lock file declares it')
		for (const u of unknown.slice(0, 3)) lines.push(`  ${u}`)
	}
	if (list.length > shown.length) lines.push(`… and ${list.length - shown.length} more changed packages, not analysed (limit).`)
	if (changed.length > list.length)
		lines.push(`${changed.length - list.length} other packages changed only in the lock file (minor or patch versions).`)
	return { text: shown.length || node ? lines.join('\n') : null, packages: shown.length, outOfRange }
}
