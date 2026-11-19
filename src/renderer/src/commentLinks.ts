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
	if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !HOST.test(u.hostname)) return null
	return u.href
}

// A host name (ASCII, so international names in their xn-- form) or an IP address. Checked here because parsers
// differ: Chromium accepts `https://exa mple.com` as the host `exa%20mple.com`, which Node rejects and no browser opens.
const HOST = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.?$|^\[[0-9a-f:.]+\]$/i

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Markdown without the HTML comments that start a line, which GitHub hides (a bot's `<!-- generated -->` marker). A
 * `<!--` inside a sentence, a code span, a fenced code block or an indented one (four spaces or a tab) is shown by
 * GitHub, so it stays; so does one never closed.
 */
export function withoutNotes(body: string): string {
	const lines = body.split('\n')
	const out: Array<string> = []
	let fence: string | null = null
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const f = FENCE.exec(line)?.[1]
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length) fence = null
			out.push(line)
			continue
		}
		if (f) {
			fence = f
			out.push(line)
			continue
		}
		// Indented four spaces or a tab, it's a code block, which GitHub shows as written.
		if (!/^ {0,3}<!--/.test(line)) {
			out.push(line)
			continue
		}
		const from = (j: number) => (j === i ? line.indexOf('<!--') + 4 : 0) // `<!-->` doesn't close itself
		let end = i
		while (end < lines.length && lines[end].indexOf('-->', from(end)) < 0) end++
		if (end === lines.length) {
			out.push(line) // never closed: GitHub shows it as text
			continue
		}
		const rest = lines[end].slice(lines[end].indexOf('-->', from(end)) + 3)
		if (rest.trim()) out.push(rest)
		i = end
	}
	return out.join('\n')
}
