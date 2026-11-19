/** Replace `text[from, to)` with `insert`, then select `[selStart, selEnd)`. */
export interface TabEdit {
	from: number
	to: number
	insert: string
	selStart: number
	selEnd: number
}

/**
 * What Tab (or Shift+Tab, `outdent`) does in a Markdown text box, like GitHub's comment box: Tab with no selection
 * types a tab; with a selection it indents every line the selection touches, so it never replaces what you selected.
 * Shift+Tab takes one tab, or up to four spaces, off the start of each of those lines.
 *
 * Null means the key does nothing to the text, so it should move focus as usual. That's the way out for someone
 * using the keyboard: Tab in an empty box, or Shift+Tab on lines with nothing to outdent.
 */
export function tabEdit(text: string, start: number, end: number, outdent: boolean): TabEdit | null {
	if (!text) return null
	if (!outdent && start === end) return { from: start, to: end, insert: '\t', selStart: start + 1, selEnd: start + 1 }
	const from = text.lastIndexOf('\n', start - 1) + 1
	// A selection ending at the very start of a line leaves that line alone, as editors do.
	const last = end > start && end > from && text[end - 1] === '\n' ? end - 1 : end
	const lineEnd = text.indexOf('\n', last)
	const to = lineEnd === -1 ? text.length : lineEnd
	const lines = text.slice(from, to).split('\n')
	const changes = lines.map((line) => {
		if (!outdent) return line ? 1 : 0 // blank lines stay blank
		if (line.startsWith('\t')) return -1
		return -/^ {0,4}/.exec(line)![0].length
	})
	if (changes.every((c) => c === 0)) return null
	const insert = lines.map((line, i) => (changes[i] > 0 ? '\t' + line : line.slice(-changes[i]))).join('\n')
	// Where a position in the old text ends up: shifted by the lines before it, and by its own line's change
	// unless it sat inside the removed indent or at the start of the line.
	const map = (pos: number): number => {
		let lineStart = from
		let shift = 0
		for (let i = 0; i < lines.length; i++) {
			const next = lineStart + lines[i].length + 1
			if (pos < next || i === lines.length - 1) {
				const c = changes[i]
				if (c > 0) return pos + shift + (pos > lineStart ? c : 0)
				return Math.max(lineStart + shift, pos + shift + c)
			}
			shift += changes[i]
			lineStart = next
		}
		return pos
	}
	return { from, to, insert, selStart: map(start), selEnd: map(end) }
}
