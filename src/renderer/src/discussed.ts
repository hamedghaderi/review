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
 * What happened to a thread since your last review: someone is waiting for your answer to a question (`asked`, however
 * long ago it was asked), someone else started it (`new`) or answered in it (`replied`),
 * the code under one you wrote in changed without an answer (`changed`), or one you wrote in is open with nothing
 * since (`waiting`). Null: nothing for you to look at. Replies GitHub left out (past the first 30) aren't checked.
 */
export type SinceMine = 'asked' | 'new' | 'replied' | 'changed' | 'waiting'

export const SINCE_ORDER: Record<SinceMine, number> = { asked: 0, new: 1, replied: 2, changed: 3, waiting: 4 }

export function sinceMine(t: DiscussionThread, mine: MyLastReview): SinceMine | null {
	if (asksYou(t, mine.viewer)) return 'asked'
	const first = t.comments[0]
	if (first && isNewSince(first, mine)) return first.author === mine.viewer ? null : 'new'
	if (t.comments.some((c) => isNewSince(c, mine) && c.author !== mine.viewer)) return 'replied'
	if (!t.comments.some((c) => c.author === mine.viewer)) return null
	if (t.changedSinceMine) return 'changed' // a fix is often resolved in the same push, so this counts when resolved too
	return t.resolved === true ? null : 'waiting'
}

/**
 * Someone is waiting for your answer: the thread is open and its last comment, by someone else, @mentions you, or asks
 * a question in a thread you wrote in. Answering (or resolving) clears it. Unknown when GitHub left replies out, since
 * the last one shown may not be the last.
 */
export function asksYou(t: DiscussionThread, viewer: string | null): boolean {
	if (!viewer || t.resolved === true || t.commentsOmitted > 0) return false
	const said = t.comments.filter((c) => !c.pending)
	const last = said[said.length - 1]
	if (!last?.author || last.author === viewer) return false
	const text = prose(last.body)
	const named = new RegExp(`(^|[^\\w/-])@${viewer}(?![\\w-])`, 'i').test(text) // logins are letters, digits and "-"
	return named || (said.some((c) => c.author === viewer) && isQuestion(text))
}

/** A question mark ending a sentence, or "wdyt". `text` is prose, without code or quotes (see `prose`). */
function isQuestion(text: string): boolean {
	return /\?(?=\s|$|[)"'\]*_])/.test(text) || /\bwdyt\b/i.test(text)
}

/** A comment without its code, quoted lines and links, where a "?" or "@name" isn't asking anyone anything. */
function prose(body: string): string {
	return body
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, '')
		.replace(/`[^`\n]*`/g, '')
		.replace(/^\s*>.*$/gm, '')
		.replace(/\bhttps?:\/\/\S+/g, '')
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
