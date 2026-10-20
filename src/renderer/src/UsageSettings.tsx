import { useEffect, useState } from 'react'
import { costCaveat, formatCost, formatTokens as tokens } from '../../shared/cost.ts'
import type {
	BudgetSettings,
	BudgetView,
	ConnectionView,
	SpendTotals,
	UsageGroup,
	UsageKind,
	UsagePeriod,
	UsageSummary,
	UsageTotals,
} from '../../shared/types.ts'

const KIND_LABEL: Record<UsageKind, string> = {
	review: 'Review runs',
	question: 'Questions about findings',
	explain: 'Questions about code',
	verify: 'Verify',
	test: 'Write test',
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
type Draft = { perRun: string; daily: string; monthly: string; connections: Record<string, { daily: string; monthly: string }> }

const field = (x: number | null): string => (x === null ? '' : String(x))
const amount = (x: string): number | null | undefined => {
	if (!x.trim()) return null
	const n = Number(x)
	return Number.isFinite(n) && n >= 0 ? n : undefined // undefined: not a valid amount
}

function toDraft(b: BudgetSettings): Draft {
	return {
		perRun: field(b.perRun),
		daily: field(b.daily),
		monthly: field(b.monthly),
		connections: Object.fromEntries(
			Object.entries(b.connections).map(([id, c]) => [id, { daily: field(c.daily), monthly: field(c.monthly) }]),
		),
	}
}

function fromDraft(d: Draft): BudgetSettings | null {
	const all = [d.perRun, d.daily, d.monthly, ...Object.values(d.connections).flatMap((c) => [c.daily, c.monthly])]
	if (all.some((x) => amount(x) === undefined)) return null
	const connections: BudgetSettings['connections'] = {}
	for (const [id, c] of Object.entries(d.connections)) {
		const daily = amount(c.daily) ?? null
		const monthly = amount(c.monthly) ?? null
		if (daily !== null || monthly !== null) connections[id] = { daily, monthly }
	}
	return { perRun: amount(d.perRun) ?? null, daily: amount(d.daily) ?? null, monthly: amount(d.monthly) ?? null, connections }
}

function Spend({ t }: { t: SpendTotals | undefined }) {
	if (!t || (t.usd === 0 && !t.inputTokens)) return <span className="muted">nothing spent</span>
	return (
		<span className="muted" title={t.unpriced ? 'Includes requests without a price, which budgets don’t limit.' : undefined}>
			{t.unpriced && t.usd === 0 ? 'cost unknown' : `${t.unpriced ? 'at least ' : ''}$${t.usd.toFixed(2)} spent`} · {tokens(t.inputTokens)}{' '}
			in, {tokens(t.outputTokens)} out
		</span>
	)
}

/** Spending limits: a run stops at its own; reaching a daily or monthly one pauses automatic reviews and asks before a run. */
function Budgets({ connections }: { connections: Array<ConnectionView> }) {
	const [view, setView] = useState<BudgetView | null>(null)
	const [draft, setDraft] = useState<Draft | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)
	useEffect(() => {
		void window.review.aiBudget().then((r) => {
			if (!r.ok) return setError(r.error.message)
			setView(r.value)
			setDraft(toDraft(r.value.budgets))
		})
	}, [])
	if (!view || !draft) return error ? <div className="error-text small">{error}</div> : null
	const next = fromDraft(draft)
	const input = (value: string, set: (v: string) => void, label: string) => (
		<input
			className={`budget-input${amount(value) === undefined ? ' invalid' : ''}`}
			inputMode="decimal"
			value={value}
			placeholder="No limit"
			aria-label={label}
			onChange={(e) => {
				setSaved(false)
				set(e.target.value)
			}}
		/>
	)
	const conn = (id: string) => draft.connections[id] ?? { daily: '', monthly: '' }
	const setConn = (id: string, key: 'daily' | 'monthly', v: string) =>
		setDraft({ ...draft, connections: { ...draft.connections, [id]: { ...conn(id), [key]: v } } })
	return (
		<form
			className="budgets"
			onSubmit={async (e) => {
				e.preventDefault()
				if (!next) return
				const r = await window.review.setBudgets(next)
				if (!r.ok) return setError(r.error.message)
				setError(null)
				setView(r.value)
				setDraft(toDraft(r.value.budgets))
				setSaved(true)
			}}
		>
			<div className="section-title">Budgets</div>
			<div className="muted small">
				In US dollars, counted from the usage history in local time. A run stops at its budget: requests under way finish, and the files it
				didn’t reach are marked skipped. When a daily or monthly budget is reached, automatic reviews wait until it allows them again, and a
				review you start asks first. Requests without a price aren’t counted, so with gateways or custom endpoints set prices for your
				models.
			</div>
			{view.paused.length > 0 && (
				<div className="notice small" role="status">
					Automatic reviews waiting for a budget: {view.paused.map((p) => p.label).join(', ')}.
				</div>
			)}
			{view.over.length > 0 && <div className="notice small">{view.over.join(' ')}</div>}
			<table className="level-table usage-table budget-table">
				<thead>
					<tr>
						<th>Budget</th>
						<th>Limit</th>
						<th>So far</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Each run</td>
						<td>{input(draft.perRun, (v) => setDraft({ ...draft, perRun: v }), 'Budget for each run')}</td>
						<td className="muted">Stops the run</td>
					</tr>
					<tr>
						<td>Each day</td>
						<td>{input(draft.daily, (v) => setDraft({ ...draft, daily: v }), 'Daily budget')}</td>
						<td>
							<Spend t={view.today} />
						</td>
					</tr>
					<tr>
						<td>Each month</td>
						<td>{input(draft.monthly, (v) => setDraft({ ...draft, monthly: v }), 'Monthly budget')}</td>
						<td>
							<Spend t={view.month} />
						</td>
					</tr>
					{connections.flatMap((c) => [
						<tr key={`${c.id}-d`}>
							<td className="ellipsis">{c.label}, each day</td>
							<td>{input(conn(c.id).daily, (v) => setConn(c.id, 'daily', v), `${c.label} daily budget`)}</td>
							<td>
								<Spend t={view.today.connections[c.id]} />
							</td>
						</tr>,
						<tr key={`${c.id}-m`}>
							<td className="ellipsis">{c.label}, each month</td>
							<td>{input(conn(c.id).monthly, (v) => setConn(c.id, 'monthly', v), `${c.label} monthly budget`)}</td>
							<td>
								<Spend t={view.month.connections[c.id]} />
							</td>
						</tr>,
					])}
				</tbody>
			</table>
			{view.month.unpriced && (
				<div className="muted small">
					“At least” and “cost unknown” include requests to models without a price. Budgets don’t limit those; set a price for a model in
					its connection to include it.
				</div>
			)}
			{error && <div className="error-text small">{error}</div>}
			<div className="form-actions">
				<button type="submit" className="btn small primary" disabled={!next}>
					Save budgets
				</button>
				{saved && <span className="muted small">Saved.</span>}
			</div>
		</form>
	)
}

export function UsageSettings({ connections }: { connections: Array<ConnectionView> }) {
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
			<Budgets connections={connections} />
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
