/**
 * Links that open a pull request's review from outside the app: `review-code://open/<owner>/<repo>/pull/<n>`, the
 * GitHub path with the scheme in front. Anyone can write such a link (in a PR comment, an email), so it carries only
 * the repository and number, and opening it never starts an AI review by itself.
 */
export const LINK_SCHEME = 'review-code'

export interface PrLink {
	repo: string // "owner/name"
	number: number
}

// GitHub's own limits: owners are 1–39 letters, digits or single hyphens, repository names up to 100 of [A-Za-z0-9._-].
const PR_PATH = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?:\/[A-Za-z0-9/_-]*)?$/

export function parsePrLink(raw: string): PrLink | null {
	if (typeof raw !== 'string' || raw.length > 512) return null
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.protocol !== `${LINK_SCHEME}:` || url.host !== 'open' || url.username || url.password || url.search || url.hash) return null
	const m = PR_PATH.exec(url.pathname.replace(/\/+$/, ''))
	if (!m || m[2] === '.' || m[2] === '..') return null
	const number = Number(m[3])
	return Number.isSafeInteger(number) ? { repo: `${m[1]}/${m[2]}`, number } : null
}

/** The first argument that is one of these links (Windows and Linux pass the link on the command line). */
export function linkInArgs(argv: ReadonlyArray<string>): string | null {
	return argv.find((a) => a.startsWith(`${LINK_SCHEME}://`)) ?? null
}
