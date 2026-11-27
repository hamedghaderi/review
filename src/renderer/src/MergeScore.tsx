import { useEffect, useState } from 'react'
import { recordText } from '../../shared/mergeScore.ts'
import type { MergeScoreView } from '../../shared/types.ts'

/**
 * How safe the change is to merge (issue #328): the AI's final score when a conclusion judged this head, otherwise the
 * data score alone, with every deduction listed. Read fresh each time it's shown, since CI and threads move.
 */
export function MergeScore({ repoId, reviewId, refresh }: { repoId: string; reviewId: string; refresh?: unknown }) {
	const [view, setView] = useState<MergeScoreView | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		let live = true
		void window.review.mergeScore(repoId, reviewId).then((r) => {
			if (!live) return
			setView(r.ok ? r.value : null)
			setError(r.ok ? null : r.error.message)
		})
		return () => {
			live = false
		}
	}, [repoId, reviewId, refresh])
	if (error) return <p className="small muted">Merge score unavailable: {error}</p>
	if (!view) return null
	const v = view.verdict
	const shown = view.final ?? view.data
	const moved = v ? v.ai - v.data : 0
	return (
		<div className="merge-score small">
			<p className="merge-score-line">
				<b>Merge safety {shown}/100</b>{' '}
				<span className="muted">
					{v
						? `· data ${view.data}, AI ${moved === 0 ? 'agrees' : moved > 0 ? `+${moved}` : moved}`
						: '· data only: write the conclusion for the AI’s score'}
				</span>
			</p>
			{v && v.why && <p className="merge-score-why selectable">{v.why}</p>}
			{view.record && <p className="merge-score-record muted">{recordText(view.record)}</p>}
			<details>
				<summary>How the data score is made</summary>
				{view.parts.length ? (
					<ul className="merge-score-parts">
						{view.parts.map((p, i) => (
							<li key={i}>
								<span className="mono">{p.points === 0 ? '±0' : p.points}</span> {p.label}
								{p.detail.length > 0 && <span className="muted">: {p.detail.join('; ')}</span>}
							</li>
						))}
					</ul>
				) : (
					<p className="muted">Nothing deducted.</p>
				)}
				<p className="muted">
					{view.tuned
						? 'Tuned against merged pull requests: each kind counts as much as it predicted fixes. See Outcomes.'
						: "The deductions are starting guesses. They aren't tuned against merged pull requests yet."}
				</p>
			</details>
		</div>
	)
}
