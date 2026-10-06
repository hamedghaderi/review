import type { PrReviewer, PrReviewState } from '../../shared/types.ts'

type Tone = 'ok' | 'bad' | 'info' | 'muted'

/**
 * One line for where a pull request stands: GitHub's decision when it reports one, otherwise what the latest reviews
 * say. Approvals given on an older commit are labelled as such. `viewer`: the connected GitHub login.
 */
/** `short` is the label without what you did yourself, for tight spots; `mine` says that part in words. */
export function reviewSummary(
	r: PrReviewState,
	viewer: string | null,
): { label: string; short: string; mine: string | null; tone: Tone; title: string } | null {
	const s = summary(r, viewer)
	if (!s) return null
	const mine = viewer ? r.reviewers.find((x) => x.login.toLowerCase() === viewer.toLowerCase()) : undefined
	const you = mine ? ` · you ${VERB[mine.verdict]}${mine.stale ? ' (older commit)' : ''}` : ''
	return { ...s, short: you && s.label.endsWith(you) ? s.label.slice(0, -you.length) : s.label, mine: you ? `You ${you.slice(7)}` : null }
}

function summary(r: PrReviewState, viewer: string | null): { label: string; tone: Tone; title: string } | null {
	const current = (v: PrReviewer['verdict']) => r.reviewers.filter((x) => x.verdict === v && !x.stale)
	const all = (v: PrReviewer['verdict']) => r.reviewers.filter((x) => x.verdict === v)
	const mine = viewer ? r.reviewers.find((x) => x.login.toLowerCase() === viewer.toLowerCase()) : undefined
	const title = describe(r)
	const you = mine ? ` · you ${VERB[mine.verdict]}${mine.stale ? ' (older commit)' : ''}` : ''
	// A change request stands until that reviewer approves or is dismissed, even after new commits.
	if (r.decision === 'changes-requested' || all('changes-requested').length) return { label: `Changes requested${you}`, tone: 'bad', title }
	if (r.decision === 'approved' || (r.decision === null && all('approved').length)) {
		const n = all('approved').length
		const old = n > 0 && current('approved').length === 0
		return { label: `Approved${n > 1 ? ` ×${n}` : ''}${old ? ' (older commit)' : ''}${you}`, tone: old ? 'info' : 'ok', title }
	}
	// Approved, but not enough for the repository's rules (more approvals, or a code owner's, are needed).
	if (all('approved').length) return { label: `${count(all('approved').length, 'approval')}, more required${you}`, tone: 'info', title }
	if (r.reviewers.length) return { label: `Reviewed${you}`, tone: 'info', title }
	if (r.decision === 'review-required')
		return { label: 'Review required', tone: 'muted', title: 'GitHub requires an approving review before merging.' }
	return null
}

const VERB: Record<PrReviewer['verdict'], string> = {
	approved: 'approved',
	'changes-requested': 'requested changes',
	commented: 'commented',
	dismissed: 'were dismissed',
}

function describe(r: PrReviewState): string {
	const lines = r.reviewers.map(
		(x) =>
			`${x.login}: ${x.verdict === 'changes-requested' ? 'requested changes' : x.verdict}${x.stale ? ' on an older commit' : ''}${x.at ? ` (${new Date(x.at).toLocaleDateString()})` : ''}`,
	)
	if (r.decision === 'review-required') lines.push('GitHub still requires an approving review.')
	return lines.join('\n')
}

function count(n: number, what: string): string {
	return `${n} ${what}${n === 1 ? '' : 's'}`
}
