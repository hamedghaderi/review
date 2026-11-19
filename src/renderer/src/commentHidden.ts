/**
 * Text in a GitHub comment that GitHub doesn't show but the AI reviewer reads: the comment's `<!-- … -->` notes. No
 * DOM, so it's tested directly; GitHubHtml's hiddenNotes supplies the text the comment shows.
 */

/**
 * The `<!-- … -->` notes in `body` (the Markdown as written, which the AI reads) that aren't part of `shown` (the
 * text of GitHub's rendering, which you read). A note GitHub shows, in a code span or block, is in `shown` and so not
 * counted; Markdown isn't parsed for it. Whitespace is compared loosely, as rendering collapses it.
 */
export function notesNotShown(body: string, shown: string): Array<string> {
	const loose = (s: string) => s.replace(/\s+/g, ' ').trim()
	const visible = loose(shown)
	return (body.match(/<!--[\s\S]*?-->/g) ?? []).filter((note) => !visible.includes(loose(note)))
}
