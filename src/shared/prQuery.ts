import type { PrFilter } from './types.ts'

/** Qualifiers passed through to the provider. Scope qualifiers (repo:, org:, user:) are dropped so a search never leaves the repository. */
export const PR_QUALIFIERS = [
	'author',
	'head',
	'base',
	'label',
	'assignee',
	'mentions',
	'commenter',
	'involves',
	'review-requested',
	'reviewed-by',
	'review',
	'is',
	'draft',
	'status',
	'milestone',
	'no',
	'created',
	'updated',
	'merged',
	'closed',
] as const

export const PR_QUERY_EXAMPLES: Array<{ query: string; description: string }> = [
	{ query: 'login bug', description: 'Title contains every word' },
	{ query: '#128', description: 'Pull request number' },
	{ query: 'https://github.com/owner/repo/pull/128', description: 'Pasted pull request URL' },
	{ query: 'author:octocat', description: 'Opened by a user (or @octocat)' },
	{ query: 'head:feat/login', description: 'Source branch' },
	{ query: 'base:release/2.0', description: 'Target branch' },
	{ query: 'review:approved', description: 'Approved (also review:changes_requested, review:none)' },
	{ query: 'reviewed-by:@me', description: 'You already reviewed' },
	{ query: 'label:bug author:@me', description: 'Combine qualifiers' },
]

export type ParsedPrQuery =
	| { kind: 'empty' }
	| { kind: 'number'; number: number }
	| { kind: 'url'; repo: string; number: number }
	| { kind: 'search'; terms: Array<string>; qualifiers: Array<[string, string]>; dropped: Array<string> }

const URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i

export function parsePrQuery(input: string): ParsedPrQuery {
	const text = input.trim()
	if (!text) return { kind: 'empty' }
	const num = /^#?(\d{1,9})$/.exec(text)
	if (num) return { kind: 'number', number: Number(num[1]) }
	const url = URL_RE.exec(text)
	if (url) return { kind: 'url', repo: `${url[1]}/${url[2].replace(/\.git$/, '')}`, number: Number(url[3]) }
	const terms: Array<string> = []
	const qualifiers: Array<[string, string]> = []
	const dropped: Array<string> = []
	for (const token of tokenize(text)) {
		const q = /^(-?)([a-z-]+):(.+)$/i.exec(token)
		if (q) {
			const key = q[2].toLowerCase()
			if ((PR_QUALIFIERS as ReadonlyArray<string>).includes(key)) {
				qualifiers.push([`${q[1]}${key}`, q[3]])
				continue
			}
			if (['repo', 'org', 'user', 'type', 'in'].includes(key)) {
				dropped.push(token)
				continue
			}
		}
		const at = /^@([A-Za-z0-9-]+)$/.exec(token)
		if (at) qualifiers.push(['author', at[1]])
		else terms.push(token)
	}
	return { kind: 'search', terms, qualifiers, dropped }
}

/** Splits on whitespace, keeping `"quoted phrases"` and `key:"quoted value"` together. */
function tokenize(s: string): Array<string> {
	return s.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? []
}

const FILTER_QUALIFIERS: Record<PrFilter, string> = {
	inbox: 'is:open review-requested:@me', // plus a second search for what you reviewed: see GitHubService.search
	open: 'is:open',
	'review-requested': 'is:open review-requested:@me',
	mine: 'author:@me',
	drafts: 'is:open draft:true',
	merged: 'is:merged',
	closed: 'is:closed is:unmerged',
	all: '',
}

export const FILTER_NEEDS_LOGIN: ReadonlySet<PrFilter> = new Set(['inbox', 'review-requested', 'mine'])

/** Builds a provider search string scoped to one repository. Title words are matched in titles only. */
export function buildSearch(
	repo: string,
	filter: PrFilter,
	parsed: Extract<ParsedPrQuery, { kind: 'search' | 'empty' }>,
	qualifiers = FILTER_QUALIFIERS[filter],
): string {
	const parts = [`repo:${repo}`, 'is:pr', qualifiers]
	if (parsed.kind === 'search') {
		for (const [k, v] of parsed.qualifiers) parts.push(`${k}:${quote(v)}`)
		const words = parsed.terms.map((t) => (t.startsWith('"') ? t : quote(t)))
		if (words.length) parts.push(...words, 'in:title')
	}
	return parts.filter(Boolean).join(' ')
}

function quote(v: string): string {
	if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v
	return /[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v
}

/** "owner/name" for github.com remote URLs (HTTPS, SSH, scp-like, git://), otherwise null. */
export function parseGitHubRemote(url: string): string | null {
	const u = url.trim()
	const m =
		/^(?:https?|git|ssh|git\+ssh):\/\/(?:[^@/]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/i.exec(u) ??
		/^(?:[^@/\s]+@)?github\.com:\/?([^/]+)\/([^/]+?)\/?$/i.exec(u)
	if (!m) return null
	const owner = m[1]
	const name = m[2].replace(/\.git$/i, '')
	if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null
	return `${owner}/${name}`
}
