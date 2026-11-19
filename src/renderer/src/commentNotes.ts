/**
 * The `<!-- -->` notes GitHub hides in a comment's Markdown, for the plain-text preview of a comment that came without
 * GitHub's HTML (GitHubHtml's commentText). No DOM, so it's tested directly.
 */

// A fence opens with three or more backticks (no backtick after them) or tildes, and closes with at least as many of
// the same character and nothing else on the line. Either can sit inside a `>` quote.
const OPEN_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const QUOTE = /^(?: {0,3}>[ \t]?)+/
const INDENTED = /^(?: {4}|\t| {1,3}\t)/ // an indented code block

interface State {
	note: boolean // inside a note opened on an earlier line
	span: number // inside a code span opened on an earlier line: its number of backticks; 0 when not
}

/**
 * Markdown without the HTML comments GitHub hides, wherever they start and however many lines they run over (a bot's
 * `<!-- generated -->` marker, `Done <!-- bot metadata -->`); text after a note's `-->` stays. A `<!--` inside a code
 * span (also one over several lines), a fenced or indented code block (also in a quote), or escaped as `\<!--`, is
 * shown by GitHub, so it stays; so does one never closed.
 */
export function withoutNotes(body: string): string {
	const lines = body.replace(/\r\n?/g, '\n').split('\n')
	let lastClose = -1 // the last line holding a `-->`: a note opened before it closes
	for (let i = lines.length - 1; i >= 0 && lastClose < 0; i--) if (lines[i].includes('-->')) lastClose = i
	// A code span can close on a later line of the same paragraph, which ends at a blank line.
	const spanClosesLater = (i: number, n: number) => {
		for (let j = i + 1; j < lines.length && lines[j].trim(); j++) if (runAt(lines[j], 0, n) >= 0) return true
		return false
	}
	const out: Array<string> = []
	let fence: { mark: string; quoted: boolean } | null = null
	const state: State = { note: false, span: 0 }
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!state.note && !state.span) {
			const quoted = QUOTE.test(line)
			const content = line.replace(QUOTE, '')
			// A fence opened in a quote ends with the quote, closed or not.
			if (fence && fence.quoted && !quoted) fence = null
			if (fence) {
				const close = CLOSE_FENCE.exec(content)?.[1]
				if (close && close[0] === fence.mark[0] && close.length >= fence.mark.length) fence = null
				out.push(line)
				continue
			}
			const open = OPEN_FENCE.exec(content)
			if (open || INDENTED.test(content)) {
				fence = open ? { mark: open[1] ?? open[2], quoted } : null
				out.push(line)
				continue
			}
		}
		const scanned = scanLine(line, state, i < lastClose, (n) => spanClosesLater(i, n))
		// A line that held only notes goes; one that never had any stays as it was, blank or not.
		if (!scanned.changed || scanned.text.trim()) out.push(scanned.text)
	}
	return out.join('\n')
}

/**
 * One line without its notes, leaving code spans and escaped characters as written; `state` carries an open note or
 * code span on to the next line. `closesLater`: a `-->` follows on a later line; `spanClosesLater(n)`: a run of `n`
 * backticks follows later in the paragraph.
 */
function scanLine(
	line: string,
	state: State,
	closesLater: boolean,
	spanClosesLater: (n: number) => boolean,
): { text: string; changed: boolean } {
	let text = ''
	let changed = state.note
	let i = 0
	while (i < line.length) {
		if (state.note) {
			const end = line.indexOf('-->', i)
			if (end < 0) return { text, changed: true }
			state.note = false
			i = end + 3
			continue
		}
		if (state.span) {
			const close = runAt(line, i, state.span)
			const to = close < 0 ? line.length : close + state.span
			text += line.slice(i, to)
			if (close >= 0) state.span = 0
			i = to
			continue
		}
		if (line[i] === '\\') {
			text += line.slice(i, i + 2)
			i += 2
			continue
		}
		if (line[i] === '`') {
			const n = /^`+/.exec(line.slice(i))![0].length
			const close = runAt(line, i + n, n)
			if (close < 0 && spanClosesLater(n)) state.span = n // the rest of the line is code
			const to = close >= 0 ? close + n : state.span ? line.length : i + n // no closing run: the backticks are text
			text += line.slice(i, to)
			i = to
			continue
		}
		if (line.startsWith('<!--', i) && (line.indexOf('-->', i + 4) >= 0 || closesLater)) {
			state.note = true
			changed = true
			i += 4 // so `<!-->` doesn't close itself
			continue
		}
		text += line[i++]
	}
	return { text, changed }
}

/** Where a run of exactly `n` backticks starts at or after `from`, which closes a code span; -1 if none. */
function runAt(line: string, from: number, n: number): number {
	const runs = /`+/g
	runs.lastIndex = from
	for (let m = runs.exec(line); m; m = runs.exec(line)) if (m[0].length === n) return m.index
	return -1
}
