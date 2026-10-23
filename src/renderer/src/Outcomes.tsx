import { useEffect, useState } from 'react'
import { costCaveat, formatCost } from '../../shared/cost.ts'
import { CATEGORY_LABEL } from '../../shared/findings.ts'
import { decidedCount, OUTCOME_GROUP_LABEL } from '../../shared/outcomes.ts'
import type {
	AiCost,
	DismissReason,
	FindingCategory,
	OutcomeCounts,
	OutcomeFilter,
	OutcomeGroup,
	OutcomePeriod,
	OutcomeRow,
	OutcomeSummary,
} from '../../shared/types.ts'
import { useStored } from './useStored.ts'

const PERIODS: Array<[OutcomePeriod, string]> = [
	['30d', 'Last 30 days'],
	['12m', 'Last 12 months'],
	['all', 'All'],
]

const DISMISS_LABEL: Record<DismissReason | 'unspecified', string> = {
	wrong: 'wrong',
	'not-worth-it': 'not worth fixing',
	'handled-elsewhere': 'handled elsewhere',
	intended: 'intended',
	unspecified: 'no reason given',
}

const DISMISS_REASONS_SHOWN = Object.keys(DISMISS_LABEL) as Array<DismissReason | 'unspecified'>

const pct = (n: number, of: number): string => `${Math.round((n / of) * 100)}%`
const dismissedOf = (c: OutcomeCounts): number => Object.values(c.dismissed).reduce((a, b) => a + b, 0)

/** "12 · 40%" once enough problems are decided, else just the count. */
function Rate({ n, c, min }: { n: number; c: OutcomeCounts; min: number }) {
	const decided = decidedCount(c)
	if (decided < min) return <>{n}</>
	return (
		<>
			{n} <span className="muted">· {pct(n, decided)}</span>
		</>
	)
}

function CostCell({ cost, accepted }: { cost: AiCost | null; accepted: number }) {
	if (!cost) return <span className="muted">—</span>
	const each = accepted ? { ...cost, usd: cost.usd / accepted } : null
	return (
		<span title={[`${formatCost(cost)} in all.`, costCaveat(cost)].filter(Boolean).join(' ')}>
			{each ? formatCost(each) : <span className="muted">none accepted</span>}
		</span>
	)
}

function Table({ title, label, rows, min }: { title: string; label: string; rows: Array<OutcomeRow>; min: number }) {
	if (!rows.length) return null
	const withCost = rows.some((r) => r.cost)
	return (
		<>
			<div className="section-title">{title}</div>
			<table className="level-table usage-table outcomes-table">
				<thead>
					<tr>
						<th>{label}</th>
						<th className="num">Raised</th>
						<th className="num" title="A comment or draft was made from it">
							Accepted
						</th>
						<th className="num" title="Dismissed for any reason">
							Dismissed
						</th>
						<th className="num" title="Dismissed as wrong: the finding was incorrect">
							Wrong
						</th>
						<th className="num" title="Neither accepted nor dismissed. Not counted in the rates.">
							Undecided
						</th>
						<th
							className="num"
							title="Its lines changed in a later snapshot and the next run didn't raise it again. The model may have missed it."
						>
							Probably fixed
						</th>
						<th className="num" title="Double-checked findings the newest check called likely wrong">
							Likely wrong
						</th>
						{withCost && (
							<th className="num cost" title="What its runs cost, divided by the problems you accepted">
								Per accepted
							</th>
						)}
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const c = r.counts
						const decided = decidedCount(c)
						const dismissed = DISMISS_REASONS_SHOWN.filter((k) => c.dismissed[k])
							.map((k) => `${c.dismissed[k]} ${DISMISS_LABEL[k]}`)
							.join(', ')
						return (
							<tr key={r.key}>
								<td
									className="ellipsis"
									title={[
										r.detail ? `${r.label} · ${r.detail}` : r.label,
										decided < min ? `${decided} decided: rates are shown from ${min}.` : `${decided} decided.`,
										c.auto ? `${c.auto} added by automatic review and never decided by you.` : null,
										c.reproduced ? `${c.reproduced} with a failing test written.` : null,
									]
										.filter(Boolean)
										.join('\n')}
								>
									{r.label}
									{r.detail && <span className="muted small"> · {r.detail}</span>}
								</td>
								<td className="num">{c.raised}</td>
								<td className="num">
									<Rate n={c.accepted} c={c} min={min} />
								</td>
								<td className="num" title={dismissed || undefined}>
									<Rate n={dismissedOf(c)} c={c} min={min} />
								</td>
								<td className="num">
									<Rate n={c.dismissed.wrong} c={c} min={min} />
								</td>
								<td className="num">{c.undecided + c.auto}</td>
								<td className="num">{c.fixed}</td>
								<td className="num" title={c.checked ? `${c.likelyWrong} of ${c.checked} double-checked` : 'None double-checked'}>
									{c.checked ? c.likelyWrong : <span className="muted">—</span>}
								</td>
								{withCost && (
									<td className="num cost">
										<CostCell cost={r.cost} accepted={c.accepted} />
									</td>
								)}
							</tr>
						)
					})}
				</tbody>
			</table>
		</>
	)
}

/**
 * The Outcomes page: what became of the AI's findings in every repository on this computer, by model, setup and rule.
 * It only reads what the reviews already store, and it never ranks models: the samples are small and not random.
 */
export function Outcomes() {
	const [period, setPeriod] = useStored<OutcomePeriod>('outcomes.period', '12m', ['30d', '12m', 'all'])
	const [rest, setRest] = useState<Omit<OutcomeFilter, 'period'>>({ repoId: null, promptVersion: null, group: null, model: null })
	const [summary, setSummary] = useState<OutcomeSummary | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		void window.review.aiOutcomes({ period, ...rest }).then((r) => {
			if (!live) return
			if (r.ok) {
				setSummary(r.value)
				setError(null)
			} else setError(r.error.message)
		})
		return () => {
			live = false
		}
	}, [period, rest])

	const s = summary
	const min = s?.minDecided ?? 10
	const set = (patch: Partial<typeof rest>) => setRest({ ...rest, ...patch })
	const groupRows = (xs: OutcomeSummary['groups']) => xs.map((g) => ({ ...g, label: OUTCOME_GROUP_LABEL[g.group] }))
	const ruleRows = (xs: OutcomeSummary['rules']) =>
		xs.map((r) => ({
			...r,
			label: CATEGORY_LABEL[r.key as FindingCategory] ?? 'Uncategorised',
			detail: r.key === 'uncategorised' ? 'runs before rules were recorded' : OUTCOME_GROUP_LABEL[r.group],
		}))
	return (
		<div className="home outcomes">
			<div className="home-head">
				<h1>Outcomes</h1>
				<span className="spacer" />
				<div className="seg" role="radiogroup" aria-label="Period">
					{PERIODS.map(([p, label]) => (
						<button key={p} role="radio" aria-checked={period === p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
							{label}
						</button>
					))}
				</div>
			</div>
			<p className="muted small home-note">
				What became of the AI’s findings in your reviews on this computer. A problem counts once however many runs, snapshots or team
				members raised it, and once for every model that raised it. Accepted means you made a comment from it. Rates are of the problems you
				accepted or dismissed, and are shown once there are {min}; undecided ones aren’t counted. The models weren’t picked at random for
				each change, so a difference between them is a hint, not a measurement.
			</p>
			{s && (
				<div className="home-tools">
					<select value={rest.repoId ?? ''} onChange={(e) => set({ repoId: e.target.value || null })} aria-label="Repository">
						<option value="">All repositories</option>
						{s.repos.map((r) => (
							<option key={r.id} value={r.id}>
								{r.label}
							</option>
						))}
					</select>
					<select value={rest.model ?? ''} onChange={(e) => set({ model: e.target.value || null })} aria-label="Model">
						<option value="">All models</option>
						{s.allModels.map((m) => (
							<option key={m.key} value={m.key}>
								{m.label}
								{m.detail ? ` · ${m.detail}` : ''}
							</option>
						))}
					</select>
					<select
						value={rest.group ?? ''}
						onChange={(e) => set({ group: (e.target.value || null) as OutcomeGroup | null })}
						aria-label="Kind of finding"
					>
						<option value="">Defects and design</option>
						{(Object.keys(OUTCOME_GROUP_LABEL) as Array<OutcomeGroup>).map((g) => (
							<option key={g} value={g}>
								{OUTCOME_GROUP_LABEL[g]}
							</option>
						))}
					</select>
					<select
						value={rest.promptVersion ?? ''}
						onChange={(e) => set({ promptVersion: e.target.value || null })}
						aria-label="Prompt version"
						title="The reviewer prompt changes between releases; compare runs on one version to leave that out"
					>
						<option value="">All prompt versions</option>
						{s.promptVersions.map((v) => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</select>
				</div>
			)}
			{error && <div className="error-text small">{error}</div>}
			{!s ? (
				!error && <p className="muted home-note">Loading…</p>
			) : s.total.raised === 0 ? (
				<p className="muted home-note">No findings from AI runs match these filters.</p>
			) : (
				<>
					<div className="usage-total">
						<b>{s.total.raised} problems</b>
						<span className="muted">
							{s.total.accepted} accepted · {dismissedOf(s.total)} dismissed ({s.total.dismissed.wrong} wrong) ·{' '}
							{s.total.undecided + s.total.auto} undecided · {s.total.fixed} probably fixed
							{s.cost ? ` · ${formatCost(s.cost)}` : ''}
						</span>
					</div>
					<Table title="By model" label="Model" rows={s.models} min={min} />
					<Table title="By setup" label="Single model or team" rows={s.setups} min={min} />
					<Table title="Defects and design" label="Kind" rows={groupRows(s.groups)} min={min} />
					<Table title="By rule" label="Rule" rows={ruleRows(s.rules)} min={min} />
					{s.cost === null && <p className="muted small">Cost can’t be split by kind of finding, so it isn’t shown with that filter.</p>}
				</>
			)}
		</div>
	)
}
