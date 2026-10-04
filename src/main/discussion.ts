import type { ChangedFile, Comparison, Discussion, DiscussionThread } from '../shared/types.ts'
import type { Activity } from './activity.ts'
import { resolveCommit } from './git.ts'
import { Mapper } from './linemap.ts'

/**
 * Places GitHub's threads on this snapshot. A thread goes inline only at a position GitHub reports as current on
 * the PR head, carried to this snapshot's lines when none of them changed in between; or, on the very commit it
 * was written on, at its original lines. Anything else is listed with its file (or the PR) with the reason, so no
 * thread silently disappears. `originalLine` is never applied to a different commit's code.
 */
export async function placeThreads(root: string, c: Comparison, a: Activity): Promise<Array<DiscussionThread>> {
	const current = a.headSha === c.headSha && !!c.pr && a.baseSha === c.pr.baseSha
	const headLocal = a.headSha === c.headSha || (await resolveCommit(root, a.headSha)) === a.headSha
	const toSnapshot = new Mapper(root, a.headSha, c.headSha)
	const short = a.headSha.slice(0, 7)
	const out: Array<DiscussionThread> = []
	for (const t of a.threads) {
		const move = !current && headLocal ? await toSnapshot.move(t.path) : null
		const file = fileFor(c.files, move ? move.path : t.path)
		const place = async (): Promise<{ placed: DiscussionThread['placed']; unplaced: string | null }> => {
			if (!file) return { placed: null, unplaced: 'The file is not part of this snapshot’s changes.' }
			if (t.subject === 'file') return { placed: { fileKey: file.key, startLine: null, endLine: null }, unplaced: null }
			const at = (start: number, end: number) => ({ placed: { fileKey: file.key, startLine: start, endLine: end }, unplaced: null })
			// On the commit it was written on, its original lines are exact.
			if (t.side === 'new' && t.originalCommit === c.headSha && t.originalLine !== null)
				return at(t.originalStartLine ?? t.originalLine, t.originalLine)
			if (t.outdated || t.line === null) return { placed: null, unplaced: 'Outdated on GitHub: the code it was written on has changed.' }
			const start = t.startLine ?? t.line
			if (current) return at(start, t.line)
			if (t.side !== 'new') return { placed: null, unplaced: `On the old side of the PR as of ${short}, which this snapshot is not.` }
			if (!headLocal)
				return { placed: null, unplaced: `Placed on a newer version of the PR (${short}). Review the update to see it in place.` }
			const r = await toSnapshot.range(move!, start, t.line)
			if (!r) return { placed: null, unplaced: `Its lines differ between this snapshot and the PR as of ${short}.` }
			return at(r.start, r.end)
		}
		const { placed, unplaced } = await place()
		out.push({
			id: t.id,
			path: t.path,
			subject: t.subject,
			side: t.side,
			resolved: t.resolved,
			resolvedBy: t.resolvedBy,
			outdated: t.outdated,
			placed,
			unplaced,
			fileKey: file?.key ?? null,
			originalLine: t.originalLine,
			diffHunk: t.diffHunk,
			comments: t.comments,
			commentsOmitted: t.commentsOmitted,
			url: t.url,
		})
	}
	return out
}

/** GitHub names both sides of a file by its new path (a deleted file by its old one). */
function fileFor(files: Array<ChangedFile>, path: string | null): ChangedFile | undefined {
	if (path === null) return undefined
	return files.find((f) => f.newPath === path) ?? files.find((f) => f.newPath === null && f.oldPath === path)
}

export function discussionOf(c: Comparison, a: Activity, threads: Array<DiscussionThread>): Discussion {
	const moved = a.headSha !== c.headSha
	const reasons = [
		a.partial,
		moved ? `This snapshot is ${c.headSha.slice(0, 7)}; GitHub's positions are for ${a.headSha.slice(0, 7)}.` : null,
	]
	const omitted = a.omitted.threads + a.omitted.comments + a.omitted.reviews + a.omitted.conversation
	if (omitted) reasons.push(`${omitted.toLocaleString()} item${omitted === 1 ? ' was' : 's were'} not read (limits).`)
	return {
		status: a.partial || omitted ? 'partial' : 'complete',
		reason: reasons.filter(Boolean).join(' ') || null,
		fetchedAt: new Date().toISOString(),
		prHead: a.headSha,
		threads,
		reviews: a.reviews,
		conversation: a.conversation,
		omitted: a.omitted,
	}
}
