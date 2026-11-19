/**
 * Text in a GitHub comment that GitHub may not show but the AI reviewer reads: the comment's `<!-- … -->` notes. No
 * DOM, so it's tested directly.
 */

/**
 * The `<!-- … -->` notes in a comment as written (which the AI reads), for the "HTML notes" line under a comment shown
 * from GitHub's HTML; none when there's no HTML, since then the comment is shown as written, notes and all.
 *
 * Every note is listed, even one GitHub shows (inside code, or escaped as `\<!--` in prose): telling those apart from
 * a real note means interpreting the Markdown as GitHub does (a backslash escapes nothing inside a raw HTML block, for
 * one), and each shortcut let a real note go unflagged. A security warning had better say too much, and Source shows
 * the comment as written to settle it. `&lt;!--` is never a note: it isn't one in the text the AI reads either.
 *
 * A note never closed counts where it starts a block (a line, also inside a `>` quote or a list item), since GitHub
 * then hides everything after it; and anywhere at the end of a body Review cut short, which may have cut a closed note
 * in two. Elsewhere inside a line an unclosed `<!--` is plain text.
 */
export function hiddenNotes(c: { body: string; bodyTruncated?: boolean; html?: string }): Array<string> {
	if (c.html === undefined) return []
	const blockStart = '(?<=(?:^|\\n)[ \\t>*+\\-\\d.)]*)' // a line's start, after any quote and list markers
	const notes = new RegExp(`<!--[\\s\\S]*?-->|${c.bodyTruncated ? '' : blockStart}<!--(?![\\s\\S]*?-->)[\\s\\S]*$`, 'g')
	return c.body.match(notes) ?? []
}
