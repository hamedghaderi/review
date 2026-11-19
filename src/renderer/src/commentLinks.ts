/**
 * Checking the links in GitHub comments (GitHubHtml): no DOM, so it's tested directly.
 */

/**
 * `href` as the http(s) address it really opens, or null when it isn't one a browser can open: not http(s), no host,
 * malformed (`https://`, a space in the host), or carrying a user name or password (`https://github.com@evil.example`
 * reads like GitHub but opens evil.example). The result is the parsed form, so what a link shows when you point at it
 * is what opens; its percent escapes are left as written, since a signed link can depend on them (see sameAddress).
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

/** Two addresses from webUrl name the same file, also when one writes a percent escape in capitals (`%2D`, `%2d`). */
export function sameAddress(a: string | null, b: string | null): boolean {
	const key = (s: string) => s.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
	return a !== null && b !== null && key(a) === key(b)
}

/**
 * A host name a browser can open (ASCII, so international names in their xn-- form) or an IP address. Checked on its
 * own because URL parsers differ: Chromium accepts `https://exa mple.com` as the host `exa%20mple.com`.
 */
export function webHost(hostname: string): boolean {
	return HOST.test(hostname)
}

const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?'
const HOST = new RegExp(`^(?:${LABEL}\\.)*${LABEL}\\.?$|^\\[[0-9a-f:.]+\\]$`, 'i')
