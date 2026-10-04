import type { PrReviewer, PrReviewState } from '../../shared/types.ts'
import { reviewSummary } from './reviewState.ts'

/** A compact badge for rows and headers. Renders nothing when nobody has reviewed and no review is required. */
export function ReviewBadge({ review, viewer }: { review: PrReviewState | null; viewer: string | null }) {
	const s = review && reviewSummary(review, viewer)
	if (!s) return null
	return (
		<span className={`rv-badge ${s.tone}`} title={s.title}>
			{s.label}
		</span>
	)
}

/** Who reviewed, grouped by verdict, for the PR preview. */
export function ReviewList({ review }: { review: PrReviewState }) {
	const group = (v: PrReviewer['verdict'], label: string) => {
		const xs = review.reviewers.filter((x) => x.verdict === v)
		if (!xs.length) return null
		return (
			<span key={v}>
				<span className="muted">{label}</span>{' '}
				{xs.map((x, i) => (
					<span key={x.login} title={x.at ? new Date(x.at).toLocaleString() : undefined}>
						{i > 0 ? ', ' : ''}
						{x.login}
						{x.stale && <span className="muted"> (older commit)</span>}
					</span>
				))}
			</span>
		)
	}
	const parts = [
		group('approved', 'Approved by'),
		group('changes-requested', 'Changes requested by'),
		group('commented', 'Commented:'),
		group('dismissed', 'Dismissed:'),
	].filter(Boolean)
	if (!parts.length)
		return (
			<span className="muted">
				{review.decision === 'review-required' ? 'No reviews yet; an approval is required.' : 'No reviews yet.'}
			</span>
		)
	return <>{parts}</>
}
