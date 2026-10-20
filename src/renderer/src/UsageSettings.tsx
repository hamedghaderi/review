import { useEffect, useState } from 'react'
import { costCaveat, formatCost } from '../../shared/cost.ts'
import type { UsageGroup, UsageKind, UsagePeriod, UsageSummary, UsageTotals } from '../../shared/types.ts'

const KIND_LABEL: Record<UsageKind, string> = {
	review: 'Review runs',
	question: 'Questions about findings',
	explain: 'Questions about code',
	verify: 'Verify',
	test: 'Write test',
}

/** "12k", "3.4M". */
function tokens(n: number): string {
	return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function Cost({ totals }: { totals: UsageTotals }) {
	const caveat = [costCaveat(totals.cost), totals.unreported ? `${totals.unreported} requests reported no usage.` : null]
		.filter(Boolean)
		.join(' ')
	return (
		<span title={caveat || undefined}>
			{formatCost(totals.cost)}
			{totals.cost.estimated ? ' est.' : ''}
		</span>
	)
}

/** Day "2026-10-20" → "Tue 20 Oct"; month "2026-10" → "October 2026". */
function periodLabel(key: string, by: UsagePeriod): string {
	const [y, m, d] = key.split('-').map(Number)
	return by === 'day'
		? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
		: new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function Rows({
	title,
	rows,
	label,
}: {
	title: string
	rows: Array<{ key: string; label: string; detail?: string | null; totals: UsageTotals }>
	label: string
}) {
	if (!rows.length) return null
	return (
		<>
			<div className="section-title">{title}</div>
			<table className="level-table usage-table">
				<thead>
					<tr>
						<th>{label}</th>
						<th className="num">Cost</th>
						<th className="num">Tokens in</th>
						<th className="num">Tokens out</th>
						<th className="num">Requests</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.key}>
							<td className="ellipsis" title={r.detail ? `${r.label} · ${r.detail}` : r.label}>
								{r.label}
								{r.detail && <span className="muted small"> · {r.detail}</span>}
							</td>
							<td className="num">
								<Cost totals={r.totals} />
							</td>
							<td className="num">{tokens(r.totals.inputTokens)}</td>
							<td className="num">{tokens(r.totals.outputTokens)}</td>
							<td className="num">{r.totals.requests.toLocaleString()}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	)
}

/** Settings → AI providers → Usage: what AI requests cost, from the usage history. */
export function UsageSettings() {
	const [by, setBy] = useState<UsagePeriod>('day')
	const [summary, setSummary] = useState<UsageSummary | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		void window.review.aiUsage(by).then((r) => {
			if (!live) return
			if (r.ok) setSummary(r.value)
			else setError(r.error.message)
		})
		return () => {
			live = false
		}
	}, [by])

	const s = summary?.by === by ? summary : null
	const groups = (xs: Array<UsageGroup>, label?: (g: UsageGroup) => string) => xs.map((g) => ({ ...g, label: label ? label(g) : g.label }))
	return (
		<div className="form usage">
			<div className="detail-head">
				<h3>Usage</h3>
				<span className="spacer" />
				<div className="seg" role="radiogroup" aria-label="Period">
					{(['day', 'month'] as const).map((p) => (
						<button key={p} role="radio" aria-checked={by === p} className={by === p ? 'on' : ''} onClick={() => setBy(p)}>
							{p === 'day' ? 'Last 30 days' : 'Last 12 months'}
						</button>
					))}
				</div>
			</div>
			<div className="muted small">
				Every AI request is counted here: review runs and retries, questions, Verify and Write test. The history is kept for 400 days apart
				from your reviews, so deleting a review keeps its usage. A cost uses the price the request was sent with. It reads “at least” when
				some requests had no price or reported no usage.
			</div>
			{error && <div className="error-text small">{error}</div>}
			{!s ? (
				!error && <div className="muted small">Loading…</div>
			) : s.total.requests === 0 ? (
				<div className="muted small">No AI requests in this period.</div>
			) : (
				<>
					<div className="usage-total">
						<b>
							<Cost totals={s.total} />
						</b>
						<span className="muted">
							{tokens(s.total.inputTokens)} tokens in · {tokens(s.total.outputTokens)} out · {s.total.requests.toLocaleString()} requests
						</span>
					</div>
					<Rows
						title={by === 'day' ? 'By day' : 'By month'}
						label={by === 'day' ? 'Day' : 'Month'}
						rows={s.periods
							.filter((p) => p.totals.requests > 0)
							.map((p) => ({ key: p.key, label: periodLabel(p.key, by), totals: p.totals }))}
					/>
					<Rows title="By connection" label="Connection" rows={groups(s.connections)} />
					<Rows title="By model" label="Model" rows={groups(s.models)} />
					<Rows title="By repository" label="Repository" rows={groups(s.repos)} />
					<Rows title="By kind" label="Kind" rows={groups(s.kinds, (g) => KIND_LABEL[g.key as UsageKind] ?? g.key)} />
				</>
			)}
		</div>
	)
}
