import { useEffect, useState } from 'react'
import { costCaveat, formatCost } from '../../shared/cost.ts'
import { CATEGORY_LABEL, LEVEL_META } from '../../shared/findings.ts'
import { decidedCount, OUTCOME_GROUP_LABEL } from '../../shared/outcomes.ts'
import { MERGE_KEYS, MIN_TRACK_RECORD, TUNE_MIN, TUNE_MIN_NEEDED } from '../../shared/mergeScore.ts'
import type {
	MergeScoreOutcomes,
	AiTextFeature,
	AiTextRow,
	AfterMergeItem,
	AiCost,
	DismissReason,
	NoteCheck,
	FindingCategory,
	JudgeRow,
	OutcomeCounts,
	OutcomeFilter,
	OutcomeGroup,
	OutcomePeriod,
	OutcomeRow,
	OutcomeSummary,
} from '../../shared/types.ts'
import { ago } from './branches.ts'
import { useStored } from './useStored.ts'
import { NotePeriods, NoteWarnings, noteWarned } from './NoteChecks.tsx'
import { noteScope } from '../../shared/notes.ts'

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

/** "2 · 1 reverted" of the problems followed past their merge; a dash when none were. */
function AfterMergeCell({ c }: { c: OutcomeCounts }) {
	if (!c.followed) return <span className="muted">—</span>
	const changed = c.reverted + c.changedAfterMerge
	return (
		<span
			title={`${c.followed} followed past the merge: ${c.reverted} reverted, ${c.changedAfterMerge} changed by a later commit. A later change is a candidate fix, not proof of one.`}
		>
			{changed}
			{c.reverted > 0 && <span className="muted"> · {c.reverted} reverted</span>}
		</span>
	)
}

/** Findings whose lines changed after their pull request merged, with the commit that changed them. */
function AfterMergeList({ items }: { items: Array<AfterMergeItem> }) {
	if (!items.length) return null
	return (
		<>
			<div className="section-title">Changed after merge</div>
			<p className="muted small">
				The first commit on the base branch that changed a finding’s lines after its pull request merged. A revert undid the pull request;
				any other change may be a fix or may be unrelated.
			</p>
			<ul className="after-merge-list">
				{items.map((i) => (
					<li key={`${i.repo}#${i.number}:${i.commit.sha}:${i.title}`}>
						<span className={`ic-state ${i.state === 'reverted' ? 'warn' : ''}`}>{i.state === 'reverted' ? 'Reverted' : 'Changed'}</span>
						<span className="ellipsis" title={i.title}>
							{i.title}
						</span>
						<span className="spacer" />
						<span className="muted small nowrap">
							#{i.number} · {i.days === 0 ? 'same day' : `${i.days} day${i.days === 1 ? '' : 's'} after merge`}
						</span>
						<a
							className="mono small nowrap"
							href={`https://github.com/${i.repo}/commit/${i.commit.sha}`}
							target="_blank"
							rel="noreferrer"
							title={i.commit.subject}
						>
							{i.commit.sha.slice(0, 7)} ↗
						</a>
					</li>
				))}
			</ul>
		</>
	)
}

/** Your reviewer notes and how each is doing (issue #278): warned ones first. Read here, changed in Settings. */
function NotesSection({ notes, onOpenNotes }: { notes: Array<NoteCheck>; onOpenNotes(): void }) {
	if (!notes.length) return null
	const repos = new Set(notes.map((c) => c.key)).size
	const sorted = [...notes].sort((a, b) => Number(noteWarned(b)) - Number(noteWarned(a)))
	return (
		<>
			<div className="section-title">Reviewer notes</div>
			<p className="muted small">
				What runs raised of each note’s kind (its rule, in its files) before and since you added it, whatever the period above. A note warns
				when you accept findings the reviewer said it covers, or when a dismissed finding of its kind was reverted after merge.{' '}
				<button className="link" onClick={onOpenNotes}>
					Open reviewer notes
				</button>
			</p>
			<ul className="note-list">
				{sorted.map((c) => (
					<li key={`${c.key}:${c.note.id}`} className={`note-card${c.note.on ? '' : ' off'}`}>
						<div className="small">
							<b>{noteScope(c.note)}</b>
							{repos > 1 && <span className="muted"> · {c.repo}</span>}
							{!c.note.on && <span className="muted"> · off</span>}
						</div>
						<p className="note-text small">{c.note.text}</p>
						<NotePeriods check={c} />
						<NoteWarnings check={c} />
					</li>
				))}
			</ul>
		</>
	)
}

function Table({
	title,
	label,
	rows,
	min,
	notWorth = false,
}: {
	title: string
	label: string
	rows: Array<OutcomeRow>
	min: number
	notWorth?: boolean // a column of its own for "not worth fixing": a level set too high shows up there
}) {
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
						{notWorth && (
							<th className="num" title="Dismissed as not worth fixing: real, but not worth the change">
								Not worth fixing
							</th>
						)}
						<th className="num" title="Neither accepted nor dismissed. Not counted in the rates.">
							Undecided
						</th>
						<th
							className="num"
							title="Its lines changed in a later snapshot and the next run didn't raise it again. The model may have missed it."
						>
							Probably fixed
						</th>
						<th
							className="num"
							title="Merged, and a later commit on the base branch changed its lines (or reverted the pull request). Follow merged pull requests to fill this in."
						>
							After merge
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
								{notWorth && (
									<td className="num">
										<Rate n={c.dismissed['not-worth-it']} c={c} min={min} />
									</td>
								)}
								<td className="num">{c.undecided + c.auto}</td>
								<td className="num">{c.fixed}</td>
								<td className="num">
									<AfterMergeCell c={c} />
								</td>
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

const AI_TEXT_LABEL: Record<AiTextFeature, string> = {
	explain: 'Explain this change',
	conclusion: 'Conclusion',
	'conclusion-answer': 'Answers about the conclusion',
	reply: 'Drafted replies',
}

/**
 * The AI's text besides findings (issue #289): how much it made, how much of it you said was wrong, and for drafted
 * replies, what you sent of them. A count of flags, never an accuracy rate: a text nobody flagged isn't shown right.
 */
/**
 * How the merge score did once pull requests merged (issue #328): how often the data score and the AI's score put a pull
 * request that needed a fix below one that didn't, and whether the deductions are tuned yet.
 */
function MergeScoreSection({ m }: { m: MergeScoreOutcomes }) {
	const t = m.tuning
	const ranked = (x: number | null) => (x === null ? 'not enough yet' : pct(x, 1))
	return (
		<>
			<div className="section-title">Merge score</div>
			<p className="muted small">
				Merged pull requests whose score you saw, once their 30 days have passed and every later change to their lines was judged. Needed a
				fix: a blocking or should-fix one. “Ranked right” is how often the score put a pull request that needed a fix lower than one that
				didn’t: 50% is a coin toss, 100% never wrong. Needs {MIN_TRACK_RECORD} pull requests and at least one of each.
			</p>
			{m.settled === 0 ? (
				<p className="muted small">None settled yet.</p>
			) : (
				<table className="level-table usage-table outcomes-table">
					<thead>
						<tr>
							<th>Score</th>
							<th className="num">Pull requests</th>
							<th className="num">Ranked right</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Data, all settled</td>
							<td className="num">{m.settled}</td>
							<td className="num">{ranked(m.data)}</td>
						</tr>
						<tr>
							<td>Data, where the AI scored too</td>
							<td className="num">{m.both}</td>
							<td className="num">{ranked(m.dataOnBoth)}</td>
						</tr>
						<tr>
							<td>AI’s final score</td>
							<td className="num">{m.both}</td>
							<td className="num">{ranked(m.aiOnBoth)}</td>
						</tr>
					</tbody>
				</table>
			)}
			<p className="muted small">
				{t.state === 'waiting'
					? `The deductions are starting guesses. They’re tuned once ${TUNE_MIN} pull requests across your repositories have settled with at least ${TUNE_MIN_NEEDED} needing a fix: ${t.settled} settled so far, ${t.needed} needed a fix.`
					: t.state === 'no-signal'
						? `The deductions don’t yet tell which of the ${t.settled} settled pull requests needed a fix, so the starting guesses stand.`
						: `Tuned on ${t.settled} settled pull requests (${t.needed} needed a fix). Each kind of deduction now counts this many times its starting guess:`}
			</p>
			{t.state === 'tuned' && (
				<ul className="small">
					{Object.entries(t.factors).map(([k, f]) => (
						<li key={k}>
							{MERGE_KEYS[k] ?? k}: {f}×
						</li>
					))}
				</ul>
			)}
		</>
	)
}

/**
 * The double-check against your decisions (issue #332): where it called a finding real or wrong and you said otherwise.
 * Agreement leaves "unsure" out and needs `min` counted, like the other rates.
 */
function JudgeSection({ rows, min }: { rows: Array<JudgeRow>; min: number }) {
	if (!rows.length) return null
	const all: JudgeRow = {
		model: 'All checkers',
		cells: { holds: { real: 0, wrong: 0 }, unsure: { real: 0, wrong: 0 }, wrong: { real: 0, wrong: 0 } },
	}
	for (const r of rows)
		for (const v of ['holds', 'unsure', 'wrong'] as const) {
			all.cells[v].real += r.cells[v].real
			all.cells[v].wrong += r.cells[v].wrong
		}
	const line = (r: JudgeRow, total = false) => {
		const c = r.cells
		const agreed = c.holds.real + c.wrong.wrong
		const judged = agreed + c.holds.wrong + c.wrong.real
		return (
			<tr key={r.model}>
				<td className="ellipsis" title={r.model}>
					{total ? <b>{r.model}</b> : r.model}
				</td>
				<td className="num">{c.holds.real}</td>
				<td className="num">{c.holds.wrong}</td>
				<td className="num">{c.wrong.real}</td>
				<td className="num">{c.wrong.wrong}</td>
				<td className="num" title={`${c.unsure.real} you accepted, ${c.unsure.wrong} you dismissed as wrong`}>
					{c.unsure.real + c.unsure.wrong}
				</td>
				<td className="num">{judged >= min ? pct(agreed, judged) : <span className="muted">—</span>}</td>
			</tr>
		)
	}
	return (
		<>
			<div className="section-title">Double-check against you</div>
			<p className="muted small">
				Double-checked findings you decided, by the model that checked. Real: you made a comment from it. Wrong: you dismissed it as wrong.
				Other dismissals, undecided findings and automatic reviews’ comments are left out, since they don’t say whether the problem was
				real. Agreement leaves “unsure” out and is shown from {min}.
			</p>
			<table className="level-table usage-table outcomes-table">
				<thead>
					<tr>
						<th>Checker</th>
						<th className="num" title="The check said it holds, and you accepted it">
							Both real
						</th>
						<th className="num" title="The check said it holds, and you dismissed it as wrong: the check let it through">
							Too lenient
						</th>
						<th className="num" title="The check said likely wrong, and you accepted it: the check would have dropped a real one">
							Too harsh
						</th>
						<th className="num" title="The check said likely wrong, and you dismissed it as wrong">
							Both wrong
						</th>
						<th className="num" title="The check couldn’t tell">
							Unsure
						</th>
						<th className="num">Agreement</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => line(r))}
					{rows.length > 1 && line(all, true)}
				</tbody>
			</table>
		</>
	)
}

function AiTextTable({ rows, notFiltered }: { rows: Array<AiTextRow>; notFiltered: boolean }) {
	if (!rows.length) return null
	const reply = (r: AiTextRow, n: number) => (r.feature === 'reply' ? n : <span className="muted">—</span>)
	return (
		<>
			<div className="section-title">AI text besides findings</div>
			<p className="muted small">
				Explanations, conclusions, answers about the conclusion and drafted replies, by model. Flagged wrong counts the ones you said were
				wrong; one nobody flagged isn’t proven right. Broken references point at a file or line that isn’t there. For drafted replies: what
				you sent. A light edit changed a fifth of the draft’s words or fewer; a draft you emptied or never sent counts as not sent.
				{notFiltered ? ' Prompt version and kind of finding don’t apply to these, so those filters are left out here.' : ''}
			</p>
			<table className="level-table usage-table outcomes-table">
				<thead>
					<tr>
						<th>Text</th>
						<th>Model</th>
						<th className="num">Made</th>
						<th className="num" title="You said it was wrong. Hover a count for what you noted.">
							Flagged wrong
						</th>
						<th
							className="num"
							title="File:line references that point at no file, or past its end, at the head commit, of those checked. Whether the code says what the text claims isn’t checked."
						>
							Broken references
						</th>
						<th className="num" title="Drafted replies you sent without changing a word">
							Sent as drafted
						</th>
						<th className="num" title="Drafted replies sent with a fifth of the words or fewer changed">
							Light edit
						</th>
						<th className="num" title="Drafted replies sent with more than a fifth of the words changed">
							Rewritten
						</th>
						<th className="num" title="Drafted replies never sent, or emptied from the reply box">
							Not sent
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const c = r.counts
						return (
							<tr key={`${r.feature}:${r.key}`}>
								<td>{AI_TEXT_LABEL[r.feature]}</td>
								<td className="ellipsis" title={r.detail ? `${r.label} · ${r.detail}` : r.label}>
									{r.label}
									{r.detail && <span className="muted small"> · {r.detail}</span>}
								</td>
								<td className="num">{c.made}</td>
								<td className="num" title={r.notes.length ? r.notes.map((n) => `“${n}”`).join('\n') : undefined}>
									{r.feature === 'reply' ? <span className="muted">—</span> : c.flagged}
								</td>
								<td className="num">
									{r.feature === 'reply' || !c.cited ? (
										<span className="muted">—</span>
									) : (
										<>
											{c.brokenRefs} <span className="muted small">of {c.cited}</span>
										</>
									)}
								</td>
								<td className="num">{reply(r, c.asDrafted)}</td>
								<td className="num">{reply(r, c.light)}</td>
								<td className="num">{reply(r, c.rewrite)}</td>
								<td className="num">{reply(r, c.made - c.asDrafted - c.light - c.rewrite)}</td>
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
export function Outcomes({ onOpenNotes }: { onOpenNotes(): void }) {
	const [period, setPeriod] = useStored<OutcomePeriod>('outcomes.period', '12m', ['30d', '12m', 'all'])
	const [rest, setRest] = useState<Omit<OutcomeFilter, 'period'>>({ repoId: null, promptVersion: null, group: null, model: null })
	const [summary, setSummary] = useState<OutcomeSummary | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [following, setFollowing] = useState(false)
	const [followNote, setFollowNote] = useState<string | null>(null)
	const [loads, setLoads] = useState(0) // bumped to read the summary again

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
	}, [period, rest, loads])

	async function follow(): Promise<void> {
		setFollowing(true)
		setFollowNote(null)
		const r = await window.review.aiFollowMerged(rest.repoId)
		setFollowing(false)
		if (!r.ok) setFollowNote(r.error.message)
		else if (r.value.problems.length) setFollowNote(`Some pull requests couldn’t be followed:\n${r.value.problems.join('\n')}`)
		setLoads((n) => n + 1)
	}

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
	const levelRows = (xs: OutcomeSummary['levels']) => xs.map((l) => ({ ...l, label: LEVEL_META[l.level]?.label ?? l.level }))
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
					<span className="spacer" />
					<span className="muted small">{s.followedAt ? `Merged pull requests followed ${ago(s.followedAt)}` : ''}</span>
					<button
						className="btn small"
						onClick={() => void follow()}
						disabled={following}
						title={`For reviewed pull requests that merged: whether a later commit on the base branch changed each finding's lines, up to 90 days after the merge. Reads GitHub and Git. Pull requests whose merge score you saw also have their own lines followed for 30 days, and each later change is judged by the model for questions.`}
					>
						{following ? 'Following…' : 'Follow merged pull requests'}
					</button>
				</div>
			)}
			{followNote && <div className="error-text small follow-note">{followNote}</div>}
			{error && <div className="error-text small">{error}</div>}
			{!s ? (
				!error && <p className="muted home-note">Loading…</p>
			) : s.total.raised === 0 ? (
				<>
					<p className="muted home-note">No findings from AI runs match these filters.</p>
					<AiTextTable rows={s.aiText} notFiltered={rest.promptVersion !== null || rest.group !== null} />
					<MergeScoreSection m={s.merge} />
				</>
			) : (
				<>
					<div className="usage-total">
						<b>{s.total.raised} problems</b>
						<span className="muted">
							{s.total.accepted} accepted · {dismissedOf(s.total)} dismissed ({s.total.dismissed.wrong} wrong) ·{' '}
							{s.total.undecided + s.total.auto} undecided · {s.total.fixed} probably fixed
							{s.total.followed ? ` · ${s.total.reverted + s.total.changedAfterMerge} changed after merge` : ''}
							{s.cost ? ` · ${formatCost(s.cost)}` : ''}
						</span>
					</div>
					<Table title="By model" label="Model" rows={s.models} min={min} />
					<Table title="By setup" label="Single model or team" rows={s.setups} min={min} />
					<Table title="Defects and design" label="Kind" rows={groupRows(s.groups)} min={min} />
					<Table title="By rule" label="Rule" rows={ruleRows(s.rules)} min={min} />
					<Table title="By level" label="Level" rows={levelRows(s.levels)} min={min} notWorth />
					<JudgeSection rows={s.judge} min={min} />
					<AfterMergeList items={s.afterMerge} />
					<AiTextTable rows={s.aiText} notFiltered={rest.promptVersion !== null || rest.group !== null} />
					<MergeScoreSection m={s.merge} />
					<NotesSection notes={s.notes} onOpenNotes={onOpenNotes} />
					{s.cost === null && <p className="muted small">Cost can’t be split by kind of finding, so it isn’t shown with that filter.</p>}
				</>
			)}
		</div>
	)
}
