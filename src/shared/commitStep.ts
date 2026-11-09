import type { Anchor, ChangedFile, Comparison } from './types.ts'

/** One changed region between two versions of a file, as `git diff -U0` gives it. */
export interface LineShift {
	oldStart: number
	oldCount: number
	newStart: number
	newCount: number
}

/**
 * Where lines start..end of the earlier version are in the later one, or null when any of them changed or lines were
 * inserted inside the range. `shifts` must be in file order.
 */
export function shiftRange(shifts: ReadonlyArray<LineShift>, start: number, end: number): { start: number; end: number } | null {
	let delta = 0
	for (const h of shifts) {
		const inside = h.oldCount ? h.oldStart <= end && h.oldStart + h.oldCount - 1 >= start : h.oldStart >= start && h.oldStart < end
		if (inside) return null
		const before = h.oldCount ? h.oldStart + h.oldCount - 1 < start : h.oldStart < start
		if (before) delta += h.newCount - h.oldCount
	}
	return { start: start + delta, end: end + delta }
}

/** The same regions, read from the later version to the earlier one. */
export function invertShifts(shifts: ReadonlyArray<LineShift>): Array<LineShift> {
	return shifts.map((h) => ({ oldStart: h.newStart, oldCount: h.newCount, newStart: h.oldStart, newCount: h.oldCount }))
}

/**
 * How a file of one commit lines up with the pull request (or branch) at its head: the file there, and the regions that
 * changed between the commit and the head. `headFileKey` is null, with `reason`, when nothing there can take a comment.
 */
export interface CommitFileMap {
	headFileKey: string | null
	reason: string | null
	shifts: Array<LineShift>
}

/**
 * A comment anchor made in a commit's diff, moved to the head of the review it belongs to, or why it can't be. Only
 * lines on the new side can move: removed lines exist at the commit's parent, which the review's own diff never shows.
 */
export function anchorToHead(a: Anchor, map: CommitFileMap, head: Comparison, commitSha: string): { anchor: Anchor } | { refused: string } {
	if (!map.headFileKey) return { refused: map.reason ?? 'This file has no place in the review’s changes to comment on.' }
	const f = head.files.find((x) => x.key === map.headFileKey)
	if (!f) return { refused: 'This file is not part of the review’s changes.' }
	const base = {
		...a,
		repoId: head.repoId,
		baseSha: head.baseSha,
		headSha: head.headSha,
		fileKey: f.key,
		oldPath: f.oldPath,
		newPath: f.newPath,
	}
	if (a.side === null || a.startLine === null || a.endLine === null)
		return { anchor: { ...base, side: null, startLine: null, endLine: null } }
	if (a.side === 'old') return { refused: 'Removed lines can’t be commented on one commit at a time. Comment on them in All changes.' }
	const r = shiftRange(map.shifts, a.startLine, a.endLine)
	if (!r) {
		const which = a.startLine === a.endLine ? `Line ${a.startLine} is` : `Lines ${a.startLine}–${a.endLine} are`
		return {
			refused: `${which} changed again by a commit after ${commitSha.slice(0, 7)}, so a comment here would point at code that is gone. Comment in that later commit or in All changes.`,
		}
	}
	return { anchor: { ...base, side: 'new', startLine: r.start, endLine: r.end } }
}

/**
 * A head anchor shown in a commit's diff: file-level ones always, line ones only when their lines are on the new side
 * and unchanged from that commit to the head. Null when it doesn't belong in this commit's view.
 */
export function anchorToCommit(a: Anchor, map: CommitFileMap, commit: Comparison, file: ChangedFile): Anchor | null {
	if (!map.headFileKey || a.fileKey !== map.headFileKey) return null
	const base = {
		...a,
		repoId: commit.repoId,
		baseSha: commit.baseSha,
		headSha: commit.headSha,
		fileKey: file.key,
		oldPath: file.oldPath,
		newPath: file.newPath,
	}
	if (a.side === null || a.startLine === null || a.endLine === null) return base
	if (a.side !== 'new') return null
	const r = shiftRange(invertShifts(map.shifts), a.startLine, a.endLine)
	return r ? { ...base, startLine: r.start, endLine: r.end } : null
}

/**
 * Where you last left a review's commits: of the heads you reviewed (your last GitHub review's, earlier snapshots'),
 * each placed at the index of the last of these commits it contains (-1: none, as after a rebase), the one furthest
 * along. Null when none reaches any of them. The new commits start at `index + 1`.
 */
export function lastReviewed<T>(reviewed: ReadonlyArray<T & { index: number }>): (T & { index: number }) | null {
	let best: (T & { index: number }) | null = null
	for (const r of reviewed) if (r.index >= 0 && (!best || r.index > best.index)) best = r
	return best
}
