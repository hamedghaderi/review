/**
 * Checking the links in GitHub comments (commentHtml): no DOM, so it's tested directly.
 */

/**
 * `href` as the http(s) address it really opens, or null when it isn't one a browser can open: not http(s), a
 * malformed host (`https://`, `exa mple.com`, `-bad.example`), one longer than DNS allows, or carrying a user name or
 * password (`https://github.com@evil.example` reads like GitHub but opens evil.example). The result is the parsed form,
 * so what a link shows when you point at it is what opens; percent escapes are left as written, since a signed link
 * can depend on them.
 *
 * The host is checked as written, before any URL parser sees it: parsers differ (Chromium's, in the app, accepts
 * `exa mple.com` as the host `exa%20mple.com`; Node's, in the tests, rejects it), so a check on their output would
 * behave differently in the app than in the tests. This one is the same string logic in both.
 */
export function webUrl(href: string | null | undefined): string | null {
	const raw = href?.trim()
	const authority = raw ? /^https?:\/\/([^/?#\\]*)/i.exec(raw)?.[1] : undefined
	if (authority === undefined || !hostAsWritten(authority)) return null
	let u: URL
	try {
		u = new URL(raw!)
	} catch {
		return null
	}
	if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !dnsSized(u.hostname)) return null
	return u.href
}

/**
 * The part between `//` and the path, as written: no user name or password, then an IP address in brackets or a host
 * name (labels of letters in any script, digits, `_` and inner `-`, separated by single dots), then an optional port.
 */
function hostAsWritten(authority: string): boolean {
	if (authority.includes('@')) return false
	const m = /^(\[[0-9a-f:.]+\]|[^:]*)(?::\d*)?$/i.exec(authority)
	return !!m && (m[1].startsWith('[') || HOST.test(m[1]))
}

const LABEL = '[\\p{L}\\p{N}_](?:[\\p{L}\\p{M}\\p{N}_-]*[\\p{L}\\p{M}\\p{N}_])?'
const HOST = new RegExp(`^(?:${LABEL}\\.)*${LABEL}\\.?$`, 'u')

/** Within DNS's limits, on the parsed (ASCII) name: labels of at most 63 characters, at most 253 in all. */
function dnsSized(hostname: string): boolean {
	if (hostname.startsWith('[')) return true
	const name = hostname.replace(/\.$/, '') // a trailing dot doesn't count
	return name.length <= 253 && name.split('.').every((label) => label.length > 0 && label.length <= 63)
}
