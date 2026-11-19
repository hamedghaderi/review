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
 * Checked in two steps. Before any URL parser sees it, the host as written may hold no whitespace, `%` or control
 * characters: that's where parsers differ (Chromium, in the app, takes `exa mple.com` as the host `exa%20mple.com`;
 * Node, in the tests, refuses it), and a string check gives the same answer in both. After parsing, the host's ASCII
 * form (international names as `xn--…`, as both parsers write them) must be a well-formed DNS name or an IP address.
 */
export function webUrl(href: string | null | undefined): string | null {
	const raw = href?.trim()
	const authority = raw ? /^https?:\/\/([^/?#\\]*)/i.exec(raw)?.[1] : undefined
	if (authority === undefined || authority.includes('@') || /[\s%\p{Cc}]/u.test(authority)) return null
	let u: URL
	try {
		u = new URL(raw!)
	} catch {
		return null
	}
	if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !dnsName(u.hostname)) return null
	return u.href
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i

/**
 * A host name in ASCII (international ones in their xn-- form) or an IP address: labels of letters, digits, `_` and
 * inner `-`, separated by single dots, at most 63 characters each and 253 in all (a trailing dot not counted).
 */
function dnsName(hostname: string): boolean {
	if (/^\[[0-9a-f:.]+\]$/i.test(hostname)) return true
	const name = hostname.replace(/\.$/, '')
	return name.length <= 253 && name.split('.').every((label) => label.length <= 63 && LABEL.test(label))
}
