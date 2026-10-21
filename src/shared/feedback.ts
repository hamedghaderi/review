/**
 * Feedback goes to the repository's issue tracker: the form only builds a prefilled `issues/new` link, which opens in
 * the browser. Nothing is sent from the app, and the person sees and can edit everything before submitting it.
 */
export const ISSUES_NEW_URL = 'https://github.com/hamedghaderi/review/issues/new'

export type FeedbackKind = 'bug' | 'idea' | 'other'

export const FEEDBACK_KINDS: ReadonlyArray<{ id: FeedbackKind; label: string; prefix: string }> = [
	{ id: 'bug', label: 'Something is wrong', prefix: 'Bug' },
	{ id: 'idea', label: 'An idea', prefix: 'Idea' },
	{ id: 'other', label: 'Something else', prefix: 'Feedback' },
]

export interface Feedback {
	kind: FeedbackKind
	title: string
	body: string
	system: string | null // "Review 0.8.0 · macOS 15.1 (arm64)", or null when they chose not to include it
}

// Browsers and GitHub cut long addresses; the body is trimmed to stay well inside that once encoded.
export const MAX_BODY = 4000

export function feedbackUrl(f: Feedback): string {
	const kind = FEEDBACK_KINDS.find((k) => k.id === f.kind) ?? FEEDBACK_KINDS[2]
	const title = f.title.trim().replace(/\s+/g, ' ')
	let body = f.body.trim()
	if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}…`
	if (f.system) body = `${body}\n\n---\n${f.system}`
	const url = new URL(ISSUES_NEW_URL)
	url.searchParams.set('title', `${kind.prefix}: ${title}`)
	url.searchParams.set('body', body)
	return url.toString()
}
