/**
 * Text in a GitHub comment that GitHub doesn't show but the AI reviewer reads: the comment's `<!-- … -->` notes. No
 * DOM, so it's tested directly; commentHtml's hiddenNotes supplies the text of the comment's code.
 */

/**
 * The `<!-- … -->` notes in `body` (the Markdown as written, which the AI reads) that GitHub doesn't show. GitHub only
 * ever shows a note as written inside code, so `canShow` is the text of the rendering's code: a note found there is
 * shown, once for each time it appears (a marker shown once in code and used once as a note is
 * one hidden note). An example written escaped (`&lt;!--`, `\<!--`) reads the same on screen but isn't a note, so it
 * can't cancel one. Whitespace is compared loosely, as rendering collapses it.
 * A `<!--` never closed counts when it starts a line: GitHub then hides everything after it (and Review may have cut
 * a long body inside a note). Inside a line it's plain text.
 */
export function notesNotShown(body: string, canShow: string): Array<string> {
	const loose = (s: string) => s.replace(/\s+/g, ' ').trim()
	const visible = loose(canShow)
	const left = new Map<string, number>() // how many more times each note's text is shown
	const notes = body.match(/(?<!\\)<!--[\s\S]*?-->|(?<=^|\n) {0,3}<!--[\s\S]*$/g) ?? [] // `\<!--` is escaped text
	return notes
		.map((note) => note.trimStart())
		.filter((note) => {
			const key = loose(note)
			if (!left.has(key)) left.set(key, visible.split(key).length - 1)
			const n = left.get(key)!
			left.set(key, n - 1)
			return n <= 0
		})
}
