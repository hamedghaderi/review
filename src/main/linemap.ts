import { AppFail, git, isSha, parseChanges, readBlob } from './git.ts'

const CODE_LINES = 40 // old lines kept to show an outdated comment's code
const BLOB_LIMIT = 8 * 1024 * 1024

/** How a path from the earlier commit appears in the later one. `null` blobs: the file is unchanged. */
export type PathMove = { path: string | null; oldBlob: string | null; newBlob: string | null }

interface Hunk0 {
	oldStart: number
	oldCount: number
	newCount: number
}

/** Maps paths and line numbers from one commit to another. */
export class Mapper {
	private root: string
	private from: string
	private to: string
	private moves: Promise<Map<string, PathMove>> | null = null
	private hunks = new Map<string, Promise<Array<Hunk0> | null>>()

	constructor(root: string, from: string, to: string) {
		this.root = root
		this.from = from
		this.to = to
	}

	async move(path: string): Promise<PathMove> {
		if (this.from === this.to) return { path, oldBlob: null, newBlob: null }
		this.moves ??= this.readMoves()
		return (await this.moves).get(path) ?? { path, oldBlob: null, newBlob: null }
	}

	private async readMoves(): Promise<Map<string, PathMove>> {
		const r = await git(this.root, [
			'diff-tree',
			'-r',
			'-M',
			'--no-ext-diff',
			'--no-textconv',
			'-z',
			'--raw',
			'--no-abbrev',
			this.from,
			this.to,
		])
		if (r.code !== 0) throw new AppFail('git-failed', `git diff-tree failed: ${r.stderr.trim()}`)
		const { files, blobs } = parseChanges(r.stdout.toString('utf8'), '')
		const out = new Map<string, PathMove>()
		for (const f of files) {
			if (!f.oldPath) continue // added in the later commit; nothing was anchored there
			const b = blobs.get(f.key)!
			out.set(f.oldPath, { path: f.newPath, oldBlob: b.oldBlob, newBlob: b.newBlob })
		}
		return out
	}

	/** The range in the later commit, or null when any of its lines changed or lines were inserted inside it. */
	async range(m: PathMove, start: number, end: number): Promise<{ start: number; end: number } | null> {
		if (!m.oldBlob || !m.newBlob || m.oldBlob === m.newBlob) return { start, end }
		const hunks = await this.diff(m.oldBlob, m.newBlob)
		if (!hunks) return null
		let delta = 0
		for (const h of hunks) {
			const inside = h.oldCount ? h.oldStart <= end && h.oldStart + h.oldCount - 1 >= start : h.oldStart >= start && h.oldStart < end
			if (inside) return null
			const before = h.oldCount ? h.oldStart + h.oldCount - 1 < start : h.oldStart < start
			if (before) delta += h.newCount - h.oldCount
		}
		return { start: start + delta, end: end + delta }
	}

	/** Changed regions between two blobs (`-U0`), or null for a binary change. */
	private diff(a: string, b: string): Promise<Array<Hunk0> | null> {
		const key = `${a}:${b}`
		let p = this.hunks.get(key)
		if (!p) {
			p = git(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', a, b]).then((r) => {
				if (r.code !== 0 && r.code !== 1) throw new AppFail('git-failed', `git diff failed: ${r.stderr.trim()}`)
				const out: Array<Hunk0> = []
				for (const m of r.stdout.toString('utf8').matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm))
					out.push({
						oldStart: Number(m[1]),
						oldCount: m[2] === undefined ? 1 : Number(m[2]),
						newCount: m[3] === undefined ? 1 : Number(m[3]),
					})
				return out.length ? out : null
			})
			this.hunks.set(key, p)
		}
		return p
	}

	/** The text of lines start..end in the earlier commit (capped), shown with an outdated comment. */
	async oldLines(path: string, m: PathMove | null, start: number, end: number): Promise<Array<string>> {
		const blob = m?.oldBlob ?? (await resolveBlob(this.root, `${this.from}:${path}`))
		if (!blob) return []
		const { buf } = await readBlob(this.root, blob, BLOB_LIMIT)
		if (buf.subarray(0, 8000).includes(0)) return []
		return buf
			.toString('utf8')
			.split('\n')
			.slice(start - 1, Math.min(end, start + CODE_LINES - 1))
			.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
	}
}

async function resolveBlob(root: string, rev: string): Promise<string | null> {
	const r = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', rev])
	const sha = r.stdout.toString('utf8').trim()
	return r.code === 0 && isSha(sha) ? sha : null
}
