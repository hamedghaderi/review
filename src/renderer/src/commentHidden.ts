/**
 * Text in a GitHub comment that GitHub may not show but the AI reviewer reads: the comment's `<!-- … -->` notes. No
 * DOM, so it's tested directly.
 */

/**
 * The `<!-- … -->` notes in a comment as written (which the AI reads), for the "Hidden text" line under a comment
 * shown from GitHub's HTML; none when there's no HTML, since then the comment is shown as written, notes and all.
 *
 * Every note is listed, even one GitHub shows because it's inside code: telling an example from a real note means
 * matching it to the rendering, and each way of doing that let a real note go unflagged. A security warning had
 * better say too much, and Source shows the comment as written to settle it.
 *
 * A note is closed anywhere it isn't escaped (`\<!--` after an odd run of backslashes; `\\` is just a backslash;
 * `&lt;!--` is never one). One never closed counts where it starts a block (a line, also inside a `>` quote or a list
 * item), since GitHub then hides everything after it; and anywhere at the end of a body Review cut short, which may
 * have cut a closed note in two. Elsewhere inside a line an unclosed `<!--` is plain text.
 */
export function hiddenNotes(c: { body: string; bodyTruncated?: boolean; html?: string }): Array<string> {
	if (c.html === undefined) return []
	const unescaped = '(?<=(?:^|[^\\\\])(?:\\\\\\\\)*)'
	const blockStart = '(?<=(?:^|\\n)[ \\t>*+\\-\\d.)]*)' // a line's start, after any quote and list markers
	const notes = new RegExp(`${unescaped}<!--[\\s\\S]*?-->|${c.bodyTruncated ? unescaped : blockStart}<!--(?![\\s\\S]*?-->)[\\s\\S]*$`, 'g')
	return c.body.match(notes) ?? []
}
