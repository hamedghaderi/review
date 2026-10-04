import type { Anchor, CarriedFrom, ChangedFile, Comparison, Review, ReviewComment, Side } from '../shared/types.ts'
import { Mapper } from './linemap.ts'

/**
 * Copies `src`'s comments into the comparison `dst`. A line comment keeps its place when none of its lines changed
 * between the two snapshots (following renames and lines added or removed above it); otherwise it becomes outdated,
 * keeping the old code, and is shown at file level. `skip` holds origin ids that must not be carried again.
 */
export async function carryComments(root: string, src: Review, dst: Comparison, skip: ReadonlySet<string>): Promise<Array<ReviewComment>> {
	const todo = src.comments.filter((c) => !skip.has(c.carried?.originId ?? c.id))
	if (!todo.length) return []
	const sides: Record<Side, Mapper> = {
		new: new Mapper(root, src.headSha, dst.headSha),
		old: new Mapper(root, src.baseSha, dst.baseSha),
	}
	const t = new Date().toISOString()
	const out: Array<ReviewComment> = []
	for (const c of todo) {
		const a = c.anchor
		const side: Side = a.side ?? (a.newPath ? 'new' : 'old')
		const path = side === 'new' ? a.newPath : a.oldPath
		const m = sides[side]
		const move = path ? await m.move(path) : null
		const file = move?.path ? dst.files.find((f) => (side === 'new' ? f.newPath : f.oldPath) === move.path) : undefined
		let outdated: CarriedFrom['outdated'] = c.carried?.outdated ?? null // once outdated, always outdated
		let range: { start: number; end: number } | null = null
		if (!outdated) {
			if (!move?.path) outdated = { reason: side === 'new' ? 'The file was deleted.' : 'The file is no longer in the base.', code: [] }
			else if (a.side && a.startLine !== null && a.endLine !== null && !(range = await m.range(move, a.startLine, a.endLine)))
				outdated = { reason: 'The commented lines changed.', code: [] }
			else if (!file) outdated = { reason: 'The file is no longer part of the changes.', code: [] }
			if (outdated && path && a.startLine !== null && a.endLine !== null)
				outdated.code = await m.oldLines(path, move, a.startLine, a.endLine)
		}
		const published = src.publication?.comments[c.id]
		out.push({
			id: crypto.randomUUID(),
			anchor: outdated ? fileAnchor(dst, file, a) : placed(dst, file!, a, range),
			body: c.body,
			createdAt: c.createdAt,
			updatedAt: t,
			findingId: null, // findings belong to the earlier snapshot's AI runs
			carried: {
				reviewId: src.id,
				commentId: c.id,
				originId: c.carried?.originId ?? c.id,
				anchor: c.carried?.outdated ? c.carried.anchor : a,
				outdated,
				published: published ? { url: published.url } : (c.carried?.published ?? null),
			},
		})
	}
	return out
}

function placed(dst: Comparison, f: ChangedFile, a: Anchor, range: { start: number; end: number } | null): Anchor {
	return {
		...a,
		repoId: dst.repoId,
		baseSha: dst.baseSha,
		headSha: dst.headSha,
		fileKey: f.key,
		oldPath: f.oldPath,
		newPath: f.newPath,
		startLine: range?.start ?? null,
		endLine: range?.end ?? null,
	}
}

/** Outdated comments sit at file level: on the file when it is still changed, otherwise on its old key (listed only). */
function fileAnchor(dst: Comparison, f: ChangedFile | undefined, a: Anchor): Anchor {
	return {
		repoId: dst.repoId,
		baseSha: dst.baseSha,
		headSha: dst.headSha,
		fileKey: f?.key ?? a.fileKey,
		oldPath: f ? f.oldPath : a.oldPath,
		newPath: f ? f.newPath : a.newPath,
		side: null,
		startLine: null,
		endLine: null,
		excerpt: a.excerpt,
	}
}
