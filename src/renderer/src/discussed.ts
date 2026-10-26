import type { Anchor, DiscussionThread, MyLastReview } from '../../shared/types.ts'

/**
 * Threads on GitHub that already cover `a`: line threads placed on overlapping lines of the same side, or file
 * threads for a file comment. Outdated or unplaced threads have no line here and never match. `own` holds the GitHub
 * ids and links of this comment's own published copy, so a comment is not "already discussed" by itself.
 * Derived when shown and stored nowhere, and it never hides or changes a comment or finding.
 */
/** The thread a comment was published as: its first GitHub comment is one of `own` (ids and links of the published copy). */
export function ownThread(threads: Array<DiscussionThread>, own: ReadonlySet<string>): DiscussionThread | null {
	if (!own.size) return null
	const c = (t: DiscussionThread) => t.comments[0]
	return threads.find((t) => c(t) && (own.has(c(t).id) || (c(t).url !== null && own.has(c(t).url!)))) ?? null
}

/** Someone other than the thread's author answered it (replies GitHub left out count, since they can't be checked). */
export function hasReply(t: DiscussionThread): boolean {
	const author = t.comments[0]?.author
	return t.commentsOmitted > 0 || t.comments.slice(1).some((c) => c.author !== author)
}

export type ThreadFilter = 'all' | 'since' | 'open' | 'resolved'

/** The GitHub panel filter. `author`: anyone who wrote in the thread, not only who started it. */
export function matchesThread(t: DiscussionThread, state: ThreadFilter, author: string | null, mine: MyLastReview | null = null): boolean {
	if (state === 'since' && (!mine || !sinceMine(t, mine))) return false
	if (state === 'open' && t.resolved !== false) return false
	if (state === 'resolved' && t.resolved !== true) return false
	return !author || t.comments.some((c) => c.author === author)
}

/**
 * What happened to a thread since your last review: someone else started it (`new`) or answered in it (`replied`),
 * the code under one you wrote in changed without an answer (`changed`), or one you wrote in is open with nothing
 * since (`waiting`). Null: nothing for you to look at. Replies GitHub left out (past the first 30) aren't checked.
 */
export type SinceMine = 'new' | 'replied' | 'changed' | 'waiting'

export const SINCE_ORDER: Record<SinceMine, number> = { new: 0, replied: 1, changed: 2, waiting: 3 }

export function sinceMine(t: DiscussionThread, mine: MyLastReview): SinceMine | null {
	const first = t.comments[0]
	if (first && isNewSince(first, mine)) return first.author === mine.viewer ? null : 'new'
	if (t.comments.some((c) => isNewSince(c, mine) && c.author !== mine.viewer)) return 'replied'
	if (!t.comments.some((c) => c.author === mine.viewer)) return null
	if (t.changedSinceMine) return 'changed' // a fix is often resolved in the same push, so this counts when resolved too
	return t.resolved === true ? null : 'waiting'
}

/** Written after your last review (your own unsubmitted comments aren't). */
export function isNewSince(c: { createdAt?: string | null; submittedAt?: string | null; pending?: boolean }, mine: MyLastReview): boolean {
	const at = c.createdAt ?? c.submittedAt ?? null
	return !c.pending && at !== null && at > mine.at
}

export function discussedAt(threads: Array<DiscussionThread>, a: Anchor, own: ReadonlySet<string> = new Set()): Array<DiscussionThread> {
	return threads.filter((t) => {
		const p = t.placed
		if (!p || p.fileKey !== a.fileKey) return false
		if (t.comments.some((c) => own.has(c.id) || (c.url !== null && own.has(c.url)))) return false
		if (a.side === null || a.startLine === null || a.endLine === null) return t.subject === 'file'
		return (
			t.subject === 'line' &&
			t.side === a.side &&
			p.startLine !== null &&
			p.endLine !== null &&
			p.startLine <= a.endLine &&
			p.endLine >= a.startLine
		)
	})
}
