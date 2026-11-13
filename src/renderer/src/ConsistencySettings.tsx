import { useEffect, useState } from 'react'
import type { ConsistencyReport, ConsistencyVariant, ConsistencyVerdict } from '../../shared/types.ts'

/**
 * Settings › AI review › Verdict consistency (issue #196): sends the open review's double-checks again with the answers
 * in reverse order and framed the other way round, and shows how often the verdict changes. It measures; it changes
 * nothing.
 */

const VARIANT_LABEL: Record<Exclude<ConsistencyVariant, 'as-is'>, string> = {
	repeat: 'Sent again unchanged (noise)',
	reversed: 'Answers in reverse order',
	reframed: 'Asked to confirm instead of disprove',
}

const SHORT: Record<ConsistencyVariant, string> = { 'as-is': 'As is', repeat: 'Again', reversed: 'Reversed', reframed: 'Confirm' }

export function ConsistencySettings({ reviewId, model }: { reviewId: string | null; model: string | null }) {
	const [plan, setPlan] = useState<{ findings: number; requests: number } | null>(null)
	const [report, setReport] = useState<ConsistencyReport | null>(null)
	const [running, setRunning] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setPlan(null)
		setReport(null)
		setError(null)
		if (!reviewId) return
		void window.review.consistencyPlan(reviewId).then((r) => (r.ok ? setPlan(r.value) : setError(r.error.message)))
	}, [reviewId])

	const run = async (): Promise<void> => {
		if (!reviewId) return
		setRunning(true)
		setError(null)
		try {
			const r = await window.review.checkConsistency(reviewId)
			if (r.ok) setReport(r.value)
			else setError(r.error.message)
		} finally {
			setRunning(false)
		}
	}

	return (
		<div className="settings-main form">
			<h3>Verdict consistency</h3>
			<p className="muted small">
				The double-check answers “holds”, “wrong” or “unsure”, and resolving threads, lowering blocking findings and holding back approvals
				depend on that answer. This sends the open review’s double-checks again: with the answers in reverse order, asked to confirm the
				finding instead of disprove it, and once more unchanged to show plain noise. A verdict that changes with the order of its answers is
				unreliable, whichever answer is right. Lookups are off, so every version reads the same code. Nothing is saved or posted.
			</p>
			{!model ? (
				<p className="small">Choose a model for questions first. The check uses it.</p>
			) : !reviewId ? (
				<p className="small">Open a review with double-checked findings, then come back here.</p>
			) : plan && !plan.findings ? (
				<p className="small">
					The open review has no double-checked findings. Run a review with double-checks on, or check whether a fixed finding is gone.
				</p>
			) : plan ? (
				<div className="form-actions start">
					<button className="btn primary" disabled={running} onClick={() => void run()}>
						{running
							? 'Checking… (this takes a few minutes)'
							: `Check ${plan.findings} finding${plan.findings === 1 ? '' : 's'}: ${plan.requests} requests to ${model}`}
					</button>
				</div>
			) : null}
			{error && <p className="small error-text">{error}</p>}
			{report && <Result report={report} />}
		</div>
	)
}

function Result({ report }: { report: ConsistencyReport }) {
	const cell = (v: ConsistencyVerdict, base: ConsistencyVerdict, variant: ConsistencyVariant) => {
		const differs = variant !== 'as-is' && v !== 'failed' && base !== 'failed' && v !== base
		const swap = differs && ((v === 'wrong' && base === 'holds') || (v === 'holds' && base === 'wrong'))
		return (
			<td key={variant} className={`${v === 'failed' ? 'cv-failed' : ''}${differs ? ' differs' : ''}${swap ? ' swap' : ''}`}>
				{v === 'failed' ? 'failed' : v}
			</td>
		)
	}
	return (
		<>
			<h4>
				{report.model}, {report.rows.length} finding{report.rows.length === 1 ? '' : 's'}
			</h4>
			<table className="consistency-table small">
				<thead>
					<tr>
						<th>Compared with as is</th>
						<th>Answered</th>
						<th>Changed</th>
						<th title="Flipped between holds and wrong: the swap that changes what the app does">holds ↔ wrong</th>
						<th>Failed</th>
					</tr>
				</thead>
				<tbody>
					{report.variants.map((v) => (
						<tr key={v.variant}>
							<td>{VARIANT_LABEL[v.variant]}</td>
							<td>{v.compared}</td>
							<td className={v.changed ? 'differs' : ''}>{v.changed}</td>
							<td className={v.wrongHolds ? 'swap' : ''}>{v.wrongHolds}</td>
							<td>{v.failed}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="muted small">
				Compare the other rows with the first: changes beyond what sending it again gives come from the order or the framing.
			</p>
			<table className="consistency-table small">
				<thead>
					<tr>
						<th>Finding</th>
						{(['as-is', 'repeat', 'reversed', 'reframed'] as const).map((v) => (
							<th key={v}>{SHORT[v]}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{report.rows.map((r) => (
						<tr key={r.findingId}>
							<td>
								<span className="ellipsis" title={r.title}>
									{r.title}
								</span>
								<span className="mono muted">
									{r.place}
									{r.kind === 'fixed' ? ' · fixed?' : ''}
								</span>
							</td>
							{(['as-is', 'repeat', 'reversed', 'reframed'] as const).map((v) => cell(r.verdicts[v], r.verdicts['as-is'], v))}
						</tr>
					))}
				</tbody>
			</table>
		</>
	)
}
