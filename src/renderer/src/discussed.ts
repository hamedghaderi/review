import type { Anchor, DiscussionThread } from '../../shared/types.ts'

/**
 * Threads on GitHub that already cover `a`: line threads placed on overlapping lines of the same side, or file
 * threads for a file comment. Outdated or unplaced threads have no line here and never match. `own` holds the GitHub
 * ids and links of this comment's own published copy, so a comment is not "already discussed" by itself.
 * Derived when shown and stored nowhere, and it never hides or changes a comment or finding.
 */
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
