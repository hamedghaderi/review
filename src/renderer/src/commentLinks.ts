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
// the same character and nothing else on the line.
const OPEN_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Markdown without the HTML comments GitHub hides: one starting a line (a bot's `<!-- generated -->` marker, possibly
 * over several lines) and closed ones inside a line (`Done <!-- bot metadata -->`). A `<!--` inside a code span, a
 * fenced code block or an indented one (four spaces or a tab), or escaped as `\<!--`, is shown by GitHub, so it
 * stays; so does one never closed.
 */
export function withoutNotes(body: string): string {
	const lines = body.split('\n')
	const out: Array<string> = []
	let fence: string | null = null
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (fence) {
			const close = CLOSE_FENCE.exec(line)?.[1]
			if (close && close[0] === fence[0] && close.length >= fence.length) fence = null
			out.push(line)
			continue
		}
		const open = OPEN_FENCE.exec(line)
		if (open) {
			fence = open[1] ?? open[2]
			out.push(line)
			continue
		}
		// Indented four spaces or a tab, it's a code block, which GitHub shows as written.
		if (/^(?: {4}|\t| {1,3}\t)/.test(line)) {
			out.push(line)
			continue
		}
		if (!/^ {0,3}<!--/.test(line)) {
			out.push(withoutInlineNotes(line))
			continue
		}
		const from = (j: number) => (j === i ? line.indexOf('<!--') + 4 : 0) // `<!-->` doesn't close itself
		let end = i
		while (end < lines.length && lines[end].indexOf('-->', from(end)) < 0) end++
		if (end === lines.length) {
			out.push(withoutInlineNotes(line)) // never closed: GitHub shows it as text
			continue
		}
		const rest = withoutInlineNotes(lines[end].slice(lines[end].indexOf('-->', from(end)) + 3))
		if (rest.trim()) out.push(rest)
		i = end
	}
	return out.join('\n')
}

/** One line without its closed `<!-- … -->` notes, leaving code spans and escaped `\<` as written. */
function withoutInlineNotes(line: string): string {
	let out = ''
	let i = 0
	while (i < line.length) {
		if (line[i] === '\\') {
			out += line.slice(i, i + 2)
			i += 2
			continue
		}
		if (line[i] === '`') {
			const run = /^`+/.exec(line.slice(i))![0]
			const close = closingRun(line, i + run.length, run.length)
			const to = close < 0 ? i + run.length : close + run.length // no closing run: the backticks are text
			out += line.slice(i, to)
			i = to
			continue
		}
		if (line.startsWith('<!--', i)) {
			const end = line.indexOf('-->', i + 4)
			if (end >= 0) {
				i = end + 3
				continue
			}
		}
		out += line[i++]
	}
	return out
}

/** Where a run of exactly `n` backticks starts at or after `from`, which closes a code span; -1 if none. */
function closingRun(line: string, from: number, n: number): number {
	const runs = /`+/g
	runs.lastIndex = from
	for (let m = runs.exec(line); m; m = runs.exec(line)) if (m[0].length === n) return m.index
	return -1
}
