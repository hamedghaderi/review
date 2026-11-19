/**
 * Plain helpers for showing GitHub comments (GitHubHtml): no DOM, so they're tested directly.
 */

/**
 * `href` as the http(s) address it really opens, or null when it isn't one a browser can open: not http(s), no host,
 * malformed (`https://`, a space in the host), or carrying a user name or password (`https://github.com@evil.example`
 * reads like GitHub but opens evil.example). The result is the parsed form, so what a link shows when you point at it
 * is what opens, and two spellings of one address compare equal.
 */
export function webUrl(href: string | null | undefined): string | null {
	if (!href || !/^https?:\/\//i.test(href.trim())) return null
	let u: URL
	try {
		u = new URL(href.trim())
	} catch {
		return null
	}
	if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !webHost(u.hostname)) return null
	return u.href
}

/**
 * A host name a browser can open (ASCII, so international names in their xn-- form) or an IP address. Checked on its
 * own because URL parsers differ: Chromium accepts `https://exa mple.com` as the host `exa%20mple.com`, which Node
 * rejects, so only a direct test of this check covers what the app sees.
 */
export function webHost(hostname: string): boolean {
	return HOST.test(hostname)
}

const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?'
const HOST = new RegExp(`^(?:${LABEL}\\.)*${LABEL}\\.?$|^\\[[0-9a-f:.]+\\]$`, 'i')

// A fence opens with three or more backticks (no backtick after them) or tildes, and closes with at least as many of
// the same character and nothing else on the line. Either can sit inside a `>` quote.
const OPEN_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const QUOTE = /^(?: {0,3}>[ \t]?)+/
const INDENTED = /^(?: {4}|\t| {1,3}\t)/ // an indented code block

/**
 * Markdown without the HTML comments GitHub hides, wherever they start and however many lines they run over (a bot's
 * `<!-- generated -->` marker, `Done <!-- bot metadata -->`); text after a note's `-->` stays. A `<!--` inside a code
 * span, a fenced or indented code block (also in a quote), or escaped as `\<!--`, is shown by GitHub, so it stays; so
 * does one never closed.
 */
export function withoutNotes(body: string): string {
	const lines = body.replace(/\r\n?/g, '\n').split('\n')
	let lastClose = -1 // the last line holding a `-->`: a note opened before it closes
	for (let i = lines.length - 1; i >= 0 && lastClose < 0; i--) if (lines[i].includes('-->')) lastClose = i
	const out: Array<string> = []
	let fence: string | null = null
	let note = false // inside a note opened on an earlier line
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!note) {
			const content = line.replace(QUOTE, '')
			if (fence) {
				const close = CLOSE_FENCE.exec(content)?.[1]
				if (close && close[0] === fence[0] && close.length >= fence.length) fence = null
				out.push(line)
				continue
			}
			const open = OPEN_FENCE.exec(content)
			if (open || INDENTED.test(content)) {
				fence = open ? (open[1] ?? open[2]) : null
				out.push(line)
				continue
			}
		}
		const scanned = scanLine(line, note, i < lastClose)
		note = scanned.note
		// A line that held only notes goes; one that never had any stays as it was, blank or not.
		if (!scanned.changed || scanned.text.trim()) out.push(scanned.text)
	}
	return out.join('\n')
}

/**
 * One line without its notes, leaving code spans and escaped characters as written. `note`: the line starts inside a
 * note; `closesLater`: a `-->` follows on a later line, so a note left open here closes there.
 */
function scanLine(line: string, note: boolean, closesLater: boolean): { text: string; note: boolean; changed: boolean } {
	let text = ''
	let changed = note
	let i = 0
	while (i < line.length) {
		if (note) {
			const end = line.indexOf('-->', i)
			if (end < 0) return { text, note: true, changed: true }
			note = false
			i = end + 3
			continue
		}
		if (line[i] === '\\') {
			text += line.slice(i, i + 2)
			i += 2
			continue
		}
		if (line[i] === '`') {
			const run = /^`+/.exec(line.slice(i))![0]
			const close = closingRun(line, i + run.length, run.length)
			const to = close < 0 ? i + run.length : close + run.length // no closing run: the backticks are text
			text += line.slice(i, to)
			i = to
			continue
		}
		if (line.startsWith('<!--', i) && (line.indexOf('-->', i + 4) >= 0 || closesLater)) {
			note = true
			changed = true
			i += 4 // so `<!-->` doesn't close itself
			continue
		}
		text += line[i++]
	}
	return { text, note, changed }
}

/** Where a run of exactly `n` backticks starts at or after `from`, which closes a code span; -1 if none. */
function closingRun(line: string, from: number, n: number): number {
	const runs = /`+/g
	runs.lastIndex = from
	for (let m = runs.exec(line); m; m = runs.exec(line)) if (m[0].length === n) return m.index
	return -1
}
