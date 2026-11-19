/**
 * Text in a GitHub comment that GitHub doesn't show but the AI reviewer reads: the comment's `<!-- … -->` notes. No
 * DOM, so it's tested directly; GitHubHtml's hiddenNotes supplies the text the comment shows.
 */

/**
 * The `<!-- … -->` notes in `body` (the Markdown as written, which the AI reads) that aren't part of `shown` (the
 * text of GitHub's rendering, which you read). A note GitHub shows, in a code span or block, is in `shown` and so not
 * counted, once for each time it's shown: a marker shown once as an example and used once as a note is one hidden
 * note. Markdown isn't parsed for it. Whitespace is compared loosely, as rendering collapses it.
 * A `<!--` never closed runs to the end of the body: GitHub hides all of it when it starts a block, and Review may have
 * cut a long body inside a note. Where GitHub shows it as text instead (inside a line), it's in `shown`, so not counted.
 */
export function notesNotShown(body: string, shown: string): Array<string> {
	const loose = (s: string) => s.replace(/\s+/g, ' ').trim()
	const visible = loose(shown)
	const left = new Map<string, number>() // how many more times each note's text is shown
	const notes = body.match(/<!--[\s\S]*?(?:-->|$)/g) ?? []
	return notes.filter((note) => {
		const key = loose(note)
		if (!left.has(key)) left.set(key, visible.split(key).length - 1)
		const n = left.get(key)!
		left.set(key, n - 1)
		return n <= 0
	})
}
