import type { BranchRef } from '../../shared/types.ts'

/** A flat, render-ready row of the branch tree: either a namespace folder or a branch. */
export type BranchRow =
	| { t: 'folder'; key: string; name: string; depth: number; open: boolean; count: number }
	| { t: 'branch'; key: string; branch: BranchRef; label: string; depth: number }

interface Folder {
	name: string
	path: string
	folders: Map<string, Folder>
	branches: Array<BranchRef>
}

/**
 * Groups branches by "/" namespace (feat/, fix/, release/…) into collapsible folders. `scope` keeps folder keys
 * unique per section, so "feat" under local and under origin collapse independently.
 */
export function branchRows(branches: Array<BranchRef>, scope: string, expanded: ReadonlySet<string>): Array<BranchRow> {
	const root: Folder = { name: '', path: '', folders: new Map(), branches: [] }
	for (const b of branches) {
		const parts = b.short.split('/')
		let node = root
		for (const part of parts.slice(0, -1)) {
			const path = node.path ? `${node.path}/${part}` : part
			let next = node.folders.get(part)
			if (!next) {
				next = { name: part, path, folders: new Map(), branches: [] }
				node.folders.set(part, next)
			}
			node = next
		}
		node.branches.push(b)
	}
	const out: Array<BranchRow> = []
	const walk = (f: Folder, depth: number): void => {
		for (const b of [...f.branches].sort(byName))
			out.push({ t: 'branch', key: b.ref, branch: b, label: b.short.slice(f.path ? f.path.length + 1 : 0), depth })
		for (const sub of [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
			const key = `${scope}:${sub.path}`
			const open = expanded.has(key)
			out.push({ t: 'folder', key, name: sub.name, depth, open, count: countAll(sub) })
			if (open) walk(sub, depth + 1)
		}
	}
	walk(root, 0)
	return out
}

function countAll(f: Folder): number {
	let n = f.branches.length
	for (const s of f.folders.values()) n += countAll(s)
	return n
}

function byName(a: BranchRef, b: BranchRef): number {
	return a.short.localeCompare(b.short)
}

/**
 * Instant branch search. Matches every whitespace-separated word against the full display name ("origin/feat/x"),
 * so "origin feat" or "upstream/main" narrow by remote too. Results keep their full name for identification.
 * Equally good matches are ordered by name, or by newest tip with `tie: 'recent'`.
 */
export function matchBranches(branches: Array<BranchRef>, query: string, tie: 'name' | 'recent' = 'name'): Array<BranchRef> {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	if (!words.length) return branches
	const scored: Array<[BranchRef, number]> = []
	for (const b of branches) {
		const name = b.name.toLowerCase()
		if (!words.every((w) => name.includes(w))) continue
		const s = b.short.toLowerCase()
		const q = words.join(' ')
		const score = (s === q || name === q ? 0 : s.startsWith(q) || name.startsWith(q) ? 1 : 2) + (b.kind === 'remote' ? 0.5 : 0)
		scored.push([b, score])
	}
	const byTie =
		tie === 'recent'
			? (x: BranchRef, y: BranchRef) => Date.parse(y.date) - Date.parse(x.date) || x.name.localeCompare(y.name)
			: (x: BranchRef, y: BranchRef) => x.name.localeCompare(y.name)
	return scored.sort((a, b) => a[1] - b[1] || byTie(a[0], b[0])).map(([b]) => b)
}

/** Base candidates for a head: the repository's ranked bases first, then everything else, never the head itself. */
export function baseOptions(branches: Array<BranchRef>, ranked: Array<string>, headRef: string): Array<BranchRef> {
	const by = new Map(branches.map((b) => [b.ref, b]))
	const first = ranked.map((r) => by.get(r)).filter((b): b is BranchRef => !!b)
	const rest = branches
		.filter((b) => !ranked.includes(b.ref))
		.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'local' ? -1 : 1))
	return [...first, ...rest].filter((b) => b.ref !== headRef)
}

/** Sidebar section, folder keys to expand, and the tree scope for showing a branch in the browser. */
export function revealBranch(b: BranchRef): { section: 'local' | `remote:${string}`; expand: Array<string> } {
	const scope = b.kind === 'local' ? 'l' : `r:${b.remote}`
	const parts = b.short.split('/').slice(0, -1)
	return {
		section: b.kind === 'local' ? 'local' : `remote:${b.remote}`,
		expand: parts.map((_, i) => `${scope}:${parts.slice(0, i + 1).join('/')}`),
	}
}

export function treeScope(section: string): string {
	return section === 'local' ? 'l' : `r:${section.slice('remote:'.length)}`
}

export function ago(iso: string): string {
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return ''
	const s = Math.max(0, (Date.now() - t) / 1000)
	if (s < 60) return 'just now'
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`
	if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
	return new Date(t).toLocaleDateString()
}

/** Picks a default base for a head: its upstream's default branch when it's a remote branch, else the repository default. */
export function defaultBaseFor(head: BranchRef, branches: Array<BranchRef>, ranked: Array<string>): string | null {
	const options = baseOptions(branches, ranked, head.ref)
	if (head.kind === 'remote') {
		const sameRemote = options.find((b) => b.remote === head.remote && ranked.includes(b.ref))
		if (sameRemote) return sameRemote.ref
	}
	return options.find((b) => ranked.includes(b.ref))?.ref ?? options[0]?.ref ?? null
}
