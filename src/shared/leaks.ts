/**
 * Keys, tokens and local paths in text Review is about to post on GitHub (issue #159). Comments are written by a model
 * that quotes code word for word, and once posted they outlive the code: a key the author removes from the PR stays in
 * the comment. These are signs, checked locally, never sent anywhere: a match is shown to a person, who decides. Fake-
 * looking values (xxxx, example, your_key…) don't count.
 */
export interface Leak {
	kind: 'credential' | 'path'
	what: string // "a GitHub token", "a path on someone's computer"
	text: string // the matched text, shortened (see maskLeak), safe to show
	start: number
	end: number
}

const CREDENTIALS: Array<{ what: string; re: RegExp; group?: number }> = [
	{ what: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
	{ what: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ what: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
	{ what: 'a Stripe key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
	{ what: 'an AI provider key', re: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{24,}/g },
	{ what: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ what: 'a private key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
	{ what: 'a JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	// A quoted value assigned to something named like a secret: password = "…", apiKey: '…'.
	{
		what: 'a password or secret value',
		re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi,
		group: 1,
	},
]

// A home folder on macOS, Linux or Windows, with the account name: what a reader shouldn't learn from a comment. CI
// runners' homes (/home/runner) are public and left alone.
const PATHS = /(?:\/Users\/(?!Shared\/)[^/\s'"`]+\/|\/home\/(?!runner\/)[^/\s'"`]+\/|\b[A-Z]:\\Users\\[^\\\s'"`]+\\)/g

const FAKE = /x{4,}|\*{3,}|\.{3}|…|example|sample|dummy|placeholder|changeme|redacted|your[_-]|<[^>]*>|\$\{|^(.)\1+$/i

/** Bits of entropy per character: real secrets are random, names and words are not. */
function entropy(s: string): number {
	const counts = new Map<string, number>()
	for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
	let h = 0
	for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
	return h
}

/** The start of a match and an ellipsis: enough to find it, not enough to use it. */
export function maskLeak(text: string): string {
	return text.startsWith('-----BEGIN') ? text : `${text.slice(0, Math.min(6, Math.floor(text.length / 3)))}…`
}

export function findLeaks(text: string): Array<Leak> {
	const out: Array<Leak> = []
	for (const c of CREDENTIALS)
		for (const m of text.matchAll(c.re)) {
			const value = c.group ? m[c.group] : m[0]
			if (FAKE.test(value)) continue
			if (c.group && entropy(value) < 3) continue // "password = 'password1'" in a test is not a secret
			const start = m.index! + (c.group ? m[0].indexOf(value) : 0)
			out.push({ kind: 'credential', what: c.what, text: maskLeak(value), start, end: start + value.length })
		}
	for (const m of text.matchAll(PATHS))
		out.push({ kind: 'path', what: 'a path on someone’s computer', text: m[0], start: m.index!, end: m.index! + m[0].length })
	return out.sort((a, b) => a.start - b.start).filter((l, i, all) => i === 0 || l.start >= all[i - 1].end)
}

/** `text` with each leak replaced by its masked form: keys keep their first characters, paths become "~/". */
export function maskLeaks(text: string): string {
	let out = ''
	let at = 0
	for (const l of findLeaks(text)) {
		out += text.slice(at, l.start) + (l.kind === 'path' ? '~/' : l.text)
		at = l.end
	}
	return out + text.slice(at)
}

/** "a GitHub token (ghp_ab…) and a path on someone's computer", for a warning. */
export function describeLeaks(leaks: Array<Leak>): string {
	const parts = [...new Set(leaks.map((l) => `${l.what} (${l.text})`))]
	return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
