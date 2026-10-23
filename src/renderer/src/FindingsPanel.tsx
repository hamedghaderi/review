import { useEffect, useMemo, useRef, useState } from 'react'
import { costCaveat, formatCost } from '../../shared/cost.ts'
import { RefText, RefLinksProvider, useRefLinks, type RefTarget } from './RefText.tsx'
import {
	CATEGORY_LABEL,
	checkedBySameModel,
	droppedFindings,
	findingState,
	unreadSummary,
	unreadText,
	verdictOf,
	findingTimeline,
	historyCounts,
	LEVEL_META,
	RESIDUE_LABEL,
	SEVERITY_ORDER,
	TEST_PATTERN_LABEL,
	type FindingState,
	type HistoryCounts,
	sinceState,
	type SinceState,
} from '../../shared/findings.ts'
import { changeRisk, DISMISS_REASONS, REVIEW_RULES } from '../../shared/types.ts'
import type {
	AiRun,
	ChangedFile,
	DiscussionThread,
	DismissReason,
	Finding,
	FindingDecision,
	FindingCategory,
	FindingMessage,
	FindingVerification,
	FindingReproducer,
	GoneFinding,
	Review,
	ReviewRule,
	Severity,
	StoredRule,
} from '../../shared/types.ts'
import { anchorLabel, anchorPath } from './Comment.tsx'
import { screenFinding } from '../../shared/screen.ts'
import { discussedAt } from './discussed.ts'
import { AlreadyDiscussed, RaisedBeforeNote } from './Discussion.tsx'
import { AiOrb } from './AiOrb.tsx'
import { useStored } from './useStored.ts'
import { personaOf } from '../../shared/personas.ts'
import { isKey, keyLabel } from './keymap.ts'

interface Props {
	runs: Array<AiRun>
	review: Review
	roots: Map<string, string>
	files: Array<ChangedFile>
	aiProblem: string | null
	threads: Array<DiscussionThread> // existing GitHub threads, to note findings that are already discussed
	selectedFindingId: string | null
	askFocus: { findingId: string; nonce: number } | null // "Ask AI" on a comment: open this finding's question box
	/** Null while any AI run is going (only one runs at a time). */
	onRetryRules: ((run: AiRun, rules: Array<ReviewRule>) => void) | null
	/** Stops a running run; the answers it already got are kept, and Resume asks the rest. */
	onStop(run: AiRun): void
	onOpen(finding: Finding): void
	/** Opens a file a finding's text refers to, at the line it names. */
	onOpenRef(t: RefTarget, line: number | null): void
	onAccept(finding: Finding): void
	onDismiss(finding: Finding, reason: DismissReason): void
	onNote(finding: Finding, note: string): void
	onRestore(finding: Finding): void
	/** Asks the model about a finding; resolves with an error message, or null once the answer is saved. */
	onAsk(finding: Finding, question: string): Promise<string | null>
	/** Double-checks a finding now; resolves with an error message, or null once the verdict is saved. */
	onVerify(finding: Finding): Promise<string | null>
	/** Writes a test that should fail while the finding holds; resolves with an error message, or null once it is saved. */
	onWriteTest(finding: Finding): Promise<string | null>
	/** Asks whether a gone finding is still in the code; resolves with an error message, or null once the verdict is saved. */
	onCheckFixed(run: AiRun, gone: GoneFinding): Promise<string | null>
	/** The GitHub thread of the comment you made from a gone finding, when it was published. */
	goneThread(gone: GoneFinding): DiscussionThread | null
	/** Resolves a GitHub thread; absent without a pull request. Resolves with an error message, or null. */
	onResolveThread?(threadId: string): Promise<string | null>
	askModelPicker: React.ReactNode // the model for questions; none picked yet: the model that raised the finding answers
}

type Filter = 'open' | 'accepted' | 'dismissed' | 'gone'

const SINCE_LABEL: Record<SinceState, string> = {
	new: 'New',
	present: 'Still present',
	fixed: 'Probably fixed',
	'not-seen': 'Not seen this time',
}
const FIXED_HINT =
	'Its lines changed or went away, and this run did not raise it again. The model can miss things, so check it before you rely on it.'

const LEVEL_FILTERS = ['all', ...Object.keys(LEVEL_META)] as Array<Severity | 'all'>
const RULE_FILTERS = ['all', ...Object.keys(CATEGORY_LABEL)] as Array<FindingCategory | 'all'>

export const RULE_LABEL: Record<StoredRule, string> = {
	bug: 'Bugs and logic errors',
	security: 'Security',
	'error-handling': 'Missing or hidden error handling',
	performance: 'Work that repeats per row, item or request',
	'breaking-change': 'Breaking changes for callers',
	'file-split': 'File takes on a second job',
	'over-engineered': 'Machinery for requirements that do not exist',
	convention: 'Differs from how the codebase does it (e.g. untranslated text)',
	'misleading-name': 'Names that say something the code does not do',
	'test-value': 'Tests that cannot catch the bug they are for',
	'residue-1': RESIDUE_LABEL[1],
	'residue-2': RESIDUE_LABEL[2],
	'residue-3': RESIDUE_LABEL[3],
	'residue-4': RESIDUE_LABEL[4],
	'residue-5': RESIDUE_LABEL[5],
	'residue-6': RESIDUE_LABEL[6],
	'residue-7': RESIDUE_LABEL[7], // runs before reviewer-2026-10-02.2
}

export function FindingsPanel({
	runs,
	review,
	roots,
	files,
	aiProblem,
	threads,
	selectedFindingId,
	askFocus,
	onRetryRules,
	onStop,
	onOpen,
	onOpenRef,
	onAccept,
	onDismiss,
	onNote,
	onRestore,
	onAsk,
	onVerify,
	onWriteTest,
	onCheckFixed,
	goneThread,
	onResolveThread,
	askModelPicker,
}: Props) {
	const [filter, setFilter] = useState<Filter>('open')
	const [level, setLevel] = useStored<Severity | 'all'>('review.findingLevel', 'all', LEVEL_FILTERS)
	const [rule, setRule] = useStored<FindingCategory | 'all'>('review.findingRule', 'all', RULE_FILTERS)
	const [query, setQuery] = useState('')
	const [since, setSince] = useState<SinceState | 'all'>('all')
	const [runId, setRunId] = useState<string | null>(null)
	const [showDetails, setShowDetails] = useState(false)
	const latest = runs[runs.length - 1] ?? null
	const run = runs.find((r) => r.id === runId) ?? latest
	const byId = useMemo(() => new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const))), [runs])
	const dropped = useMemo(() => (run ? droppedFindings(run, runs, review, roots) : null), [run, runs, review, roots])
	const sinceCounts = useMemo(() => (run ? historyCounts(review, run, runs, roots) : null), [run, runs, review, roots])
	const order = useMemo(() => new Map(files.map((f, i) => [f.key, i])), [files])

	const items = useMemo(() => {
		if (!run) return []
		return (
			run.findings
				.map((f) => ({ f, state: findingState(review, roots, f, byId) }))
				.filter((it) => !it.f.heldBack || it.state !== 'open')
				// Folded under another finding as the same problem: shown there, unless you chose to show it on its own.
				.filter((it) => !it.f.mergedInto || it.state !== 'open' || review.findingDecisions[it.f.id]?.status === 'open')
				.sort(
					(a, b) =>
						SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
						(order.get(a.f.anchor.fileKey) ?? 1e9) - (order.get(b.f.anchor.fileKey) ?? 1e9) ||
						(a.f.anchor.startLine ?? 0) - (b.f.anchor.startLine ?? 0),
				)
		)
	}, [run, review, roots, byId, order])

	// A finding opened from its comment ("Ask AI") is shown under the filter it belongs to, and its run is picked.
	useEffect(() => {
		if (!selectedFindingId) return
		const owner = runs.find((r) => r.findings.some((f) => f.id === selectedFindingId))
		if (owner && owner.id !== run?.id) setRunId(owner.id)
		const f = owner?.findings.find((x) => x.id === selectedFindingId)
		if (f) pickTab(findingState(review, roots, f, byId))
		if (f && !matches(f)) {
			setLevel('all')
			setRule('all')
			setQuery('')
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedFindingId])

	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	const matches = (f: Finding): boolean => {
		if (level !== 'all' && f.severity !== level) return false
		if (rule !== 'all' && f.category !== rule) return false
		const text = `${f.title}\n${f.body ?? f.evidence}\n${anchorPath(f.anchor)}`.toLowerCase()
		return words.every((w) => text.includes(w))
	}
	const gone = run?.history?.gone ?? []
	const sinceOf = (f: Finding): SinceState | null => (run ? sinceState(run, f) : null)
	const filtered = items.filter((it) => matches(it.f))
	const goneFiltered = gone.filter((g) => matches(g.finding))
	const counts: Record<Filter, number> = { open: 0, accepted: 0, dismissed: 0, gone: goneFiltered.length }
	for (const it of filtered) counts[it.state]++
	const inTab =
		filter === 'gone'
			? gone.map((g) => ({ f: g.finding, since: g.state }))
			: items.filter((it) => it.state === filter).map((it) => ({ f: it.f, since: sinceOf(it.f) }))
	const levels = [...new Set(inTab.map((it) => it.f.severity))].sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])
	const rules = [...new Set(inTab.flatMap((it) => (it.f.category ? [it.f.category] : [])))]
	const sinceOptions = run?.history ? ((filter === 'gone' ? ['fixed', 'not-seen'] : ['new', 'present']) as Array<SinceState>) : []
	const shown = filter === 'gone' ? [] : filtered.filter((it) => it.state === filter && (since === 'all' || sinceOf(it.f) === since))
	const goneShown = filter === 'gone' ? goneFiltered.filter((g) => since === 'all' || g.state === since) : []
	const narrowed = level !== 'all' || rule !== 'all' || since !== 'all' || words.length > 0
	const pickTab = (k: Filter): void => {
		setFilter(k)
		setSince('all')
	}
	// A repeat from a later run inherits the decision on the finding it repeats; that one holds the reason and note.
	const decisionOwner = (f: Finding): { finding: Finding; decision: FindingDecision | null } => {
		const seen = new Set<string>()
		for (let cur: Finding | undefined = f; cur && !seen.has(cur.id); cur = cur.repeatOf ? byId.get(cur.repeatOf) : undefined) {
			seen.add(cur.id)
			const d = review.findingDecisions[cur.id]
			if (d) return { finding: cur, decision: d }
		}
		return { finding: f, decision: null }
	}
	const [dismissMenu, setDismissMenu] = useState<string | null>(null) // finding id whose reason menu is open
	const links = useRefLinks(
		review.id,
		files,
		shown.flatMap(({ f }) =>
			[f.body, f.reasoning, f.disproof, f.background, f.problem, f.consequence, f.suggestion].filter((t): t is string => !!t),
		),
		onOpenRef,
	)

	// Keyboard triage while the Findings panel is shown, with the keys from Settings › Keymap (j/k move, a adds to the
	// review, d opens the dismiss reasons by default); then 1-4 picks a reason.
	const keys = useRef({ shown, selectedFindingId, dismissMenu })
	keys.current = { shown, selectedFindingId, dismissMenu }
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			const t = e.target as HTMLElement | null
			if (document.querySelector('.modal')) return
			const plain = !e.metaKey && !e.ctrlKey && !e.altKey
			if (plain && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
			const { shown: list, selectedFindingId: sel, dismissMenu: menu } = keys.current
			const at = list.findIndex((it) => it.f.id === sel)
			const cur = at >= 0 ? list[at] : null
			const k = e.key
			const down = isKey(e, 'findingNext')
			if (down || isKey(e, 'findingPrev')) {
				const next = list[at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (down ? 1 : -1)))]
				if (next) onOpen(next.f)
			} else if (isKey(e, 'findingAccept') && cur?.state === 'open') onAccept(cur.f)
			else if (isKey(e, 'findingDismiss') && cur?.state === 'open') setDismissMenu(menu === cur.f.id ? null : cur.f.id)
			else if (plain && menu && cur && cur.f.id === menu && /^[1-4]$/.test(k)) {
				setDismissMenu(null)
				onDismiss(cur.f, DISMISS_REASONS[Number(k) - 1])
			} else if (k === 'Escape' && menu) setDismissMenu(null)
			else return
			e.preventDefault()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onOpen, onAccept, onDismiss])

	if (!run) {
		return (
			<div className="comments-list">
				<div className="muted pad small">
					No AI review has been run for this comparison. Use “Run AI review” in the header; nothing is sent until you start a run.
					{aiProblem ? <p className="error-text">{aiProblem}</p> : null}
				</div>
			</div>
		)
	}

	return (
		<div className="comments findings-scroll">
			<RunSummary
				run={run}
				since={sinceCounts}
				showDetails={showDetails}
				onToggleDetails={() => setShowDetails((x) => !x)}
				onRetryRules={onRetryRules && ((rules) => onRetryRules(run, rules))}
				onStop={() => onStop(run)}
			/>
			{dropped && (
				<div className="small unexplained dropped">
					<b>
						Not raised again: the previous run on this snapshot raised {dropped.findings.length} finding
						{dropped.findings.length === 1 ? '' : 's'} this run didn’t
					</b>{' '}
					(runs vary, so check {dropped.findings.length === 1 ? 'it' : 'them'} before deciding):
					<ul>
						{dropped.findings.map((f) => (
							<li key={f.id}>
								<button
									className="link"
									title="Show it in the run that raised it"
									onClick={() => {
										setRunId(dropped.from.id)
										pickTab(findingState(review, roots, f, byId))
										onOpen(f)
									}}
								>
									{f.title}
								</button>{' '}
								<span className="muted">
									({LEVEL_META[f.severity].label.toLowerCase()},{' '}
									<span className="mono">
										{f.anchor.newPath ?? f.anchor.oldPath ?? f.anchor.fileKey}
										{f.anchor.startLine !== null ? `:${f.anchor.startLine}` : ''}
									</span>
									)
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{runs.length > 1 && (
				<div className="run-picker">
					<select value={run.id} onChange={(e) => setRunId(e.target.value)} aria-label="AI review run">
						{[...runs].reverse().map((r, i) => (
							<option key={r.id} value={r.id}>
								{i === 0 ? 'Latest · ' : ''}
								{new Date(r.startedAt).toLocaleString()} ·{' '}
								{r.carriedFrom && r.scope.kind === 'files'
									? `${r.scope.fileKeys.length} changed since ${r.carriedFrom.headSha.slice(0, 7)}`
									: r.scope.kind === 'all'
										? 'all files'
										: r.scope.kind === 'files'
											? `${r.scope.fileKeys.length} files`
											: 'one file'}{' '}
								· {r.status}
							</option>
						))}
					</select>
				</div>
			)}
			<div className="seg findings-seg" role="tablist">
				{(['open', 'accepted', 'dismissed', ...(gone.length ? ['gone' as const] : [])] as const).map((k) => (
					<button
						key={k}
						role="tab"
						aria-selected={filter === k}
						className={filter === k ? 'on' : ''}
						onClick={() => pickTab(k)}
						title={k === 'gone' ? `Raised by the run on ${run.history!.from.headSha.slice(0, 7)}, and not by this one` : undefined}
					>
						{k === 'open' ? 'Open' : k === 'accepted' ? 'Added' : k === 'dismissed' ? 'Dismissed' : 'Gone'}{' '}
						<span className="count">{counts[k]}</span>
					</button>
				))}
			</div>
			{(items.length > 0 || gone.length > 0) && (
				<div className="findings-filters">
					<input
						className="search"
						type="search"
						placeholder="Filter by text or file"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<select value={level} onChange={(e) => setLevel(e.target.value as Severity | 'all')} aria-label="Level">
						<option value="all">All levels</option>
						{[...new Set([...levels, ...(level === 'all' ? [] : [level])])].map((l) => (
							<option key={l} value={l}>
								{LEVEL_META[l].label} ({inTab.filter((it) => it.f.severity === l).length})
							</option>
						))}
					</select>
					{sinceOptions.length > 0 && (
						<select
							value={since}
							onChange={(e) => setSince(e.target.value as SinceState | 'all')}
							aria-label={`Since ${run.history!.from.headSha.slice(0, 7)}`}
						>
							<option value="all">Since {run.history!.from.headSha.slice(0, 7)}: all</option>
							{sinceOptions.map((k) => (
								<option key={k} value={k}>
									{SINCE_LABEL[k]} ({inTab.filter((it) => it.since === k).length})
								</option>
							))}
						</select>
					)}
					{(rules.length > 1 || rule !== 'all') && (
						<select value={rule} onChange={(e) => setRule(e.target.value as FindingCategory | 'all')} aria-label="Rule">
							<option value="all">All rules</option>
							{[...new Set([...rules, ...(rule === 'all' ? [] : [rule])])].map((c) => (
								<option key={c} value={c}>
									{CATEGORY_LABEL[c]} ({inTab.filter((it) => it.f.category === c).length})
								</option>
							))}
						</select>
					)}
				</div>
			)}
			<RefLinksProvider value={links}>
				<div className="comments-list">
					{filter === 'gone' && goneShown.length > 0 ? (
						goneShown.map((g) => (
							<GoneCard
								key={g.finding.id}
								gone={g}
								at={run.history!.from.headSha}
								thread={goneThread(g)}
								onCheck={run.status === 'running' ? null : () => onCheckFixed(run, g)}
								onResolve={onResolveThread}
							/>
						))
					) : shown.length === 0 && goneShown.length === 0 ? (
						<div className="muted pad small">
							{narrowed && inTab.length > 0 ? (
								<>
									No findings match.{' '}
									<button
										className="link"
										onClick={() => {
											setLevel('all')
											setRule('all')
											setSince('all')
											setQuery('')
										}}
									>
										Clear filters
									</button>
								</>
							) : (
								emptyText(run, filter, items.length)
							)}
						</div>
					) : (
						shown.map(({ f, state }) => (
							<FindingCard
								key={f.id}
								finding={f}
								state={state}
								fixture={run.fixture}
								team={run.team}
								sameModel={checkedBySameModel(run, f)}
								discussed={discussedAt(threads, f.anchor).filter((t) => t.id !== f.raisedBefore?.threadId)}
								earlier={f.raisedBefore ? (threads.find((t) => t.id === f.raisedBefore!.threadId) ?? null) : null}
								screened={screenFinding(f, review?.pr?.repo ?? null)}
								selected={f.id === selectedFindingId}
								focusAsk={askFocus?.findingId === f.id ? askFocus.nonce : null}
								onOpen={() => onOpen(f)}
								onAccept={() => onAccept(f)}
								onDismiss={(reason) => {
									setDismissMenu(null)
									onDismiss(f, reason)
								}}
								dismissMenu={dismissMenu === f.id}
								onToggleDismissMenu={() => setDismissMenu(dismissMenu === f.id ? null : f.id)}
								decision={decisionOwner(f).decision}
								onNote={(note) => onNote(decisionOwner(f).finding, note)}
								onRestore={() => onRestore(f)}
								folded={run.findings.filter(
									(x) => x.mergedInto === f.id && findingState(review, roots, x, byId) === 'open' && !review.findingDecisions[x.id],
								)}
								foldedUnder={f.mergedInto ? (byId.get(f.mergedInto)?.title ?? null) : null}
								onShowSeparately={(x) => onRestore(x)}
								onAsk={(q) => onAsk(f, q)}
								onVerify={() => onVerify(f)}
								onWriteTest={() => onWriteTest(f)}
								timeline={run.history ? findingTimeline(f, run.headSha) : null}
								askModelPicker={askModelPicker}
								askDisabled={run.status === 'running' ? 'Wait for the run to finish before asking.' : null}
							/>
						))
					)}
				</div>
			</RefLinksProvider>
		</div>
	)
}

function emptyText(run: AiRun, filter: Filter, total: number): string {
	if (filter === 'gone') return 'This run raised everything the earlier one did.'
	if (filter !== 'open') return filter === 'accepted' ? 'No findings added to the review yet.' : 'No dismissed findings.'
	if (run.status === 'running') return 'Waiting for results…'
	if (total > 0) return 'Every finding from this run has been added or dismissed.'
	if (run.status === 'failed') return 'The run failed, so there are no results. See the errors above.'
	if (run.status === 'cancelled') return 'The run was cancelled before any findings were reported.'
	if (run.status === 'partial') return 'No findings in the files that were reviewed. Some files were not reviewed; see coverage above.'
	return 'No findings in the reviewed scope.'
}

const STATUS_TEXT: Record<AiRun['status'], string> = {
	running: 'Running',
	completed: 'Completed',
	partial: 'Partial',
	failed: 'Failed',
	cancelled: 'Cancelled',
}

function memberName(run: AiRun, id: string | null | undefined): string | null {
	const m = id ? run.team?.members.find((x) => x.id === id) : undefined
	return m ? m.role : null
}

function TeamStatus({ run }: { run: AiRun }) {
	if (!run.team) return null
	// Members get only the files their rules apply to; older runs shared every file.
	const routed = run.coverage.supplied.some((s) => s.memberId)
	const filesOf = (id: string): number => new Set(run.coverage.supplied.filter((s) => s.memberId === id).map((s) => s.fileKey)).size
	return (
		<div className="team-status small">
			{run.team.members.map((m) => (
				<div key={m.id} className={`member-line ${m.status}`} title={m.error ?? `${m.connectionLabel} · ${m.model}`}>
					{m.status === 'running' ? (
						<AiOrb activity={m.requestsDone + m.requestsFailed > 0 || m.requestsTotal > 0 ? 'working' : 'waiting'} size={14} />
					) : (
						<span className={`member-dot ${m.status}`} aria-hidden />
					)}
					<b>{m.role}</b>
					<span className="muted mono ellipsis">{m.model}</span>
					<span className="spacer" />
					<span className="muted nowrap">
						{m.status === 'running'
							? `${m.requestsDone + m.requestsFailed}/${m.requestsTotal || '…'}`
							: m.status === 'failed'
								? 'failed'
								: m.status === 'cancelled'
									? 'cancelled'
									: m.requestsFailed
										? `${m.requestsFailed} failed`
										: 'done'}
						{routed ? ` · ${filesOf(m.id)} file${filesOf(m.id) === 1 ? '' : 's'}` : ''}
						{m.usage ? ` · ${Math.round(m.usage.inputTokens / 1000)}k tokens` : ''}
						{m.cost && (
							<span title={costCaveat(m.cost) ?? undefined}>
								{` · ${m.cost.unpriced && m.cost.usd === 0 ? 'no price' : formatCost(m.cost)}`}
								{m.cost.estimated ? ' est.' : ''}
							</span>
						)}
					</span>
				</div>
			))}
		</div>
	)
}

/** The app's risk estimate for the run's files: the high-risk ones by name with why, the rest as counts. */
function RiskLine({ files }: { files: AiRun['coverage']['files'] }) {
	const rated = files.filter((f) => f.risk)
	if (!rated.length) return null
	const high = rated.filter((f) => f.risk!.level === 'high')
	const count = (level: string) => rated.filter((f) => f.risk!.level === level).length
	return (
		<div className="muted">
			Risk (estimated from paths and the kind of change, riskiest reviewed first): {changeRisk(rated)} overall; {high.length} high
			{high.length ? ` (${high.map((f) => `${f.fileKey}: ${f.risk!.reasons.join(', ')}`).join('; ')})` : ''}, {count('medium')} medium,{' '}
			{count('low')} low.
		</div>
	)
}

/** "Since 1a2b3c4: 3 probably fixed, 2 new, 5 still present", leaving out what is zero. */
function SinceLine({ since, history }: { since: HistoryCounts; history: NonNullable<AiRun['history']> }) {
	const parts = [
		since.fixed && `${since.fixed} probably fixed`,
		since.fresh && `${since.fresh} new`,
		since.present && `${since.present} still present`,
		since.dismissed && `${since.dismissed} dismissed`,
		since.notSeen && `${since.notSeen} not seen this time`,
	].filter(Boolean)
	const at = history.from.headSha.slice(0, 7)
	return (
		<div
			className="small"
			title="Compared with the newest finished run on an earlier snapshot. Probably fixed: its lines changed and this run didn’t raise it again, which the model can also miss."
		>
			<b>Since {at}:</b> {parts.length ? parts.join(', ') : 'no findings then or now'}
			{history.rewritten
				? '. The commits were rewritten since then (a force-push), so lines were matched head to head.'
				: history.baseMoved
					? '. The base moved since then.'
					: ''}
		</div>
	)
}

/** "Citations: 3 findings cite lines their reviewer never read (Bugs: 2, Security: 1)." Nothing when none do. */
function UnreadLine({ run }: { run: AiRun }) {
	const u = unreadSummary(run)
	if (!u.findings && !u.checks) return null
	const who = run.team ? ` (${[...u.byMember].map(([id, n]) => `${memberName(run, id) ?? 'unknown reviewer'}: ${n}`).join(', ')})` : ''
	const parts = [
		u.findings
			? `${u.findings} finding${u.findings === 1 ? '' : 's'} cite${u.findings === 1 ? 's' : ''} lines ${u.findings === 1 ? 'its' : 'their'} reviewer never read${who}`
			: null,
		u.checks ? `${u.checks} double-check${u.checks === 1 ? '' : 's'} did` : null,
	].filter(Boolean)
	return (
		<div className="muted" title="References in the text checked against the excerpts, related code and lookups each request had.">
			Citations: {parts.join('; ')}.
		</div>
	)
}

function RunSummary({
	run,
	since,
	showDetails,
	onToggleDetails,
	onRetryRules,
	onStop,
}: {
	run: AiRun
	since: HistoryCounts | null
	showDetails: boolean
	onToggleDetails(): void
	onRetryRules: ((rules: Array<ReviewRule>) => void) | null
	onStop(): void
}) {
	const files = run.coverage.files
	const reviewed = files.filter((f) => f.state === 'reviewed').length
	const carried = files.filter((f) => f.state === 'carried').length
	const partial = files.filter((f) => f.state === 'partial').length
	const notReviewed = files.filter((f) => f.state === 'skipped' || f.state === 'failed' || f.state === 'cancelled' || f.state === 'pending')
	const notReviewable = files.filter((f) => f.state === 'not-reviewable')
	return (
		<div className={`run-summary st-${run.status}`}>
			<div className="run-line">
				<span className={`run-status ${run.status}`}>{STATUS_TEXT[run.status]}</span>
				{run.fixture && (
					<span className="pill warn" title="Results come from the deterministic fixture provider, not a real model">
						Fixture results
					</span>
				)}
				<span
					className="muted small ellipsis"
					title={
						run.team
							? run.team.members.map((m) => `${m.role}: ${m.model}${lensNote(m.persona)}`).join('\n')
							: `${run.providerLabel} · ${run.model}${lensNote(run.persona)}`
					}
				>
					{run.team
						? `${run.team.name} · ${run.team.members.length === 1 ? run.team.members[0].model : `${run.team.members.length} reviewers`}`
						: `${run.connectionLabel ?? run.providerLabel} · ${run.model}${lensNote(run.persona)}`}
				</span>
				<span className="spacer" />
				{run.status === 'running' && (
					<button
						className="btn small ghost run-stop"
						title="Stop this run. Answers that already arrived are kept; Resume asks the rest."
						onClick={onStop}
					>
						Stop
					</button>
				)}
				<button className="link" onClick={onToggleDetails}>
					{showDetails ? 'Hide details' : 'Details'}
				</button>
			</div>
			<div className="small">
				<b>Coverage:</b> {reviewed} of {files.length} file{files.length === 1 ? '' : 's'} fully reviewed
				{carried ? `, ${carried} carried from the run on ${run.carriedFrom?.headSha.slice(0, 7) ?? 'an earlier snapshot'}` : ''}
				{partial ? `, ${partial} partly` : ''}
				{notReviewed.length ? `, ${notReviewed.length} not reviewed` : ''}
				{notReviewable.length ? `, ${notReviewable.length} not reviewable` : ''}
				{run.status === 'running' && run.coverage.batchesTotal > 0
					? ` · request ${Math.min(run.coverage.batchesDone + run.coverage.batchesFailed + 1, run.coverage.batchesTotal)} of ${run.coverage.batchesTotal}`
					: ''}
			</div>
			<div className="small">
				<b>Findings:</b> {run.findings.filter((f) => !f.heldBack && !f.mergedInto).length}
				{run.findings.some((f) => f.heldBack) ? ` · ${run.findings.filter((f) => f.heldBack).length} over the review limits` : ''}
				{run.merged ? ` · ${run.merged.findings} grouped with another as the same problem` : ''}
				{run.rejected.length ? ` · ${run.rejected.length} rejected by validation` : ''}
			</div>
			{since && run.history && <SinceLine since={since} history={run.history} />}
			{(run.rechecked ?? []).length > 0 && (
				<div className="small">
					<b>Reviewed again, diff unchanged:</b>{' '}
					{run.rechecked!.map((r, i) => (
						<span key={r.fileKey}>
							{i ? '; ' : ''}
							<span className="mono">{r.fileKey}</span>
							{r.names.length > 0 && (
								<>
									{' '}
									uses {r.names.map((n) => `\`${n}\``).join(', ')}, changed in <span className="mono">{r.changedIn.join(', ')}</span>
								</>
							)}
							{r.names.length > 0 && r.cited?.length ? ',' : ''}
							{r.cited?.length ? (
								<>
									{' '}
									has a finding citing <span className="mono">{r.cited.join(', ')}</span>, which changed
								</>
							) : null}
						</span>
					))}
				</div>
			)}
			<TeamStatus run={run} />
			<Checked run={run} onRetry={onRetryRules} />
			{(run.ciUncovered ?? []).length > 0 && (
				<div className="small unexplained">
					<b>
						CI flagged {run.ciUncovered!.length} place{run.ciUncovered!.length === 1 ? '' : 's'} in added lines that no finding covers
					</b>{' '}
					(check them yourself):
					<ul>
						{run.ciUncovered!.map((a, i) => (
							<li key={i}>
								<span className="mono">
									{a.path}:{a.startLine}
								</span>{' '}
								{a.check} ({a.level}): {a.title ? `${a.title}: ` : ''}
								{a.message}
							</li>
						))}
					</ul>
				</div>
			)}
			{(run.unexplained ?? []).length > 0 && (
				<div className="small unexplained">
					<b>Changes the reviewer could not connect to the purpose</b> (ask the author):
					<ul>
						{run.unexplained!.map((u) => (
							<li key={u.fileKey}>
								<span className="mono">{u.fileKey}</span>: {u.why}
							</li>
						))}
					</ul>
				</div>
			)}
			{(run.outdatedDocs ?? []).length > 0 && (
				<div className="small unexplained">
					<b>Project docs this change makes wrong</b> (update them with the change):
					<ul>
						{run.outdatedDocs!.map((d, i) => (
							<li key={i}>
								<span className="mono">
									{d.path}
									{d.line === null ? '' : `:${d.line}`}
								</span>
								: {d.why}
							</li>
						))}
					</ul>
				</div>
			)}
			{run.errors.length > 0 && <div className="small error-text">{errorText(run, run.errors[run.errors.length - 1])}</div>}
			{showDetails && (
				<div className="run-details small">
					<div className="muted">
						{run.connectionLabel && run.connectionLabel !== run.providerLabel
							? `${run.connectionLabel} (${run.providerLabel})`
							: run.providerLabel}{' '}
						· {run.model}
						{lensNote(run.persona)}
						{run.endpoint && !run.fixture ? ` · ${run.endpoint}` : ''} · prompt {run.promptVersion} · started{' '}
						{new Date(run.startedAt).toLocaleString()}
						{run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleTimeString()}` : ''}
					</div>
					{run.limitsUsed && (
						<div className="muted">
							Input per request: {run.limitsUsed.maxBatchChars.toLocaleString()} chars, {run.limitsUsed.contextLines} context lines (model
							context {run.limitsUsed.contextWindow.toLocaleString()} tokens, {run.limitsUsed.outputTokens.toLocaleString()} reserved for
							output)
						</div>
					)}
					<RiskLine files={run.coverage.files} />
					{run.coverage.related ? (
						<div className="muted">
							Related code: {run.coverage.related.sent.toLocaleString()} snippet{run.coverage.related.sent === 1 ? '' : 's'} (
							{run.coverage.related.chars.toLocaleString()} chars) for {run.coverage.related.symbols.toLocaleString()} name
							{run.coverage.related.symbols === 1 ? '' : 's'} searched
							{run.coverage.related.omitted ? `; ${run.coverage.related.omitted.toLocaleString()} left out for size` : ''}.{' '}
							{run.coverage.related.notes.join(' ')}
						</div>
					) : run.limitsUsed && run.limitsUsed.relatedCode === false ? (
						<div className="muted">Related code: off (only the changed excerpts were sent).</div>
					) : null}
					{run.coverage.lookups ? (
						<div className="muted">
							Lookups: {run.coverage.lookups.calls.toLocaleString()} in {run.coverage.lookups.requests.toLocaleString()} request
							{run.coverage.lookups.requests === 1 ? '' : 's'} ({run.coverage.lookups.chars.toLocaleString()} chars)
							{run.coverage.lookups.refused ? `, ${run.coverage.lookups.refused.toLocaleString()} refused` : ''}.
							{run.coverage.lookups.paths.length ? ` Read: ${run.coverage.lookups.paths.join(', ')}.` : ''}
							{run.coverage.lookups.searches.length ? ` Searched: ${run.coverage.lookups.searches.map((x) => `“${x}”`).join(', ')}.` : ''}
							{run.coverage.lookups.external?.length ? ` MCP tools: ${run.coverage.lookups.external.join(', ')}.` : ''}
						</div>
					) : run.limitsUsed && run.limitsUsed.lookups === false ? (
						<div className="muted">Lookups: off (the reviewer could not open other files or search).</div>
					) : null}
					<UnreadLine run={run} />
					{run.coverage.lookups?.externalUnavailable?.map((x, i) => (
						<div key={`mcp${i}`} className="warn-text">
							MCP server not used: {x}
						</div>
					))}
					{(run.coverage.facts ?? []).map((f, i) => (
						<div key={`f${i}`} className="muted">
							{FACT_LABEL[f.kind]}: {f.text}
						</div>
					))}
					{(run.notices ?? []).map((n, i) => (
						<div key={i} className="muted">
							{n}
						</div>
					))}
					{run.usage && (
						<div className="muted">
							Tokens: {run.usage.inputTokens.toLocaleString()} in ({run.usage.cachedInputTokens.toLocaleString()} cached),{' '}
							{run.usage.outputTokens.toLocaleString()} out ({run.usage.reasoningTokens.toLocaleString()} reasoning)
						</div>
					)}
					{run.cost && (
						<div className="muted" title={costCaveat(run.cost) ?? undefined}>
							Cost: {formatCost(run.cost)}
							{run.cost.estimated ? ' (estimated)' : ''}
						</div>
					)}
					{(notReviewed.length > 0 || partial > 0 || notReviewable.length > 0) && (
						<Details title="Files not fully reviewed">
							{files
								.filter((f) => f.state !== 'reviewed' && f.state !== 'carried')
								.map((f) => (
									<li key={f.fileKey}>
										<span className="mono">{f.fileKey}</span> — {f.state}
										{f.reason ? `: ${f.reason}` : ''}
									</li>
								))}
						</Details>
					)}
					{run.coverage.skippedRanges.length > 0 && (
						<Details title={`Skipped ranges (${run.coverage.skippedRanges.length})`}>
							{run.coverage.skippedRanges.map((r, i) => (
								<li key={i}>
									<span className="mono">{r.fileKey}</span>
									{r.new ? ` new ${r.new.start}–${r.new.end}` : ''}
									{r.old ? ` old ${r.old.start}–${r.old.end}` : ''} — {r.reason}
								</li>
							))}
						</Details>
					)}
					{run.limitations.length > 0 && (
						<Details title={`Reviewer limitations (${run.limitations.length})`}>
							{run.limitations.map((l, i) => (
								<li key={i}>{l}</li>
							))}
						</Details>
					)}
					{run.findings.some((f) => f.heldBack) && (
						<Details title={`Over the review limits (${run.findings.filter((f) => f.heldBack).length})`}>
							{run.findings
								.filter((f) => f.heldBack)
								.map((f) => (
									<li key={f.id}>
										<b>{f.title}</b> <span className="mono">{anchorPath(f.anchor)}</span> — {f.heldBack}
									</li>
								))}
						</Details>
					)}
					{run.rejected.length > 0 && (
						<Details title={`Rejected findings (${run.rejected.length})`}>
							{run.rejected.map((r, i) => (
								<li key={i}>
									<b>{r.title || '(untitled)'}</b> — {r.reason}
								</li>
							))}
						</Details>
					)}
					{run.errors.length > 1 && (
						<Details title={`Errors (${run.errors.length})`}>
							{run.errors.map((e, i) => (
								<li key={i}>{errorText(run, e)}</li>
							))}
						</Details>
					)}
					<Details title={`Supplied source (${run.coverage.supplied.length} excerpts)`}>
						{run.coverage.supplied.map((s) => (
							<li key={`${s.memberId ?? ''}:${s.excerptId}`}>
								{s.excerptId}: <span className="mono">{s.fileKey}</span>
								{s.memberId ? ` (${run.team?.members.find((m) => m.id === s.memberId)?.role ?? 'member'})` : ''}
								{s.new ? ` new ${s.new.start}–${s.new.end}` : ''}
								{s.old ? ` old ${s.old.start}–${s.old.end}` : ''}
							</li>
						))}
					</Details>
				</div>
			)}
		</div>
	)
}

/**
 * A failed request's error stays until every rule of its reviewer has been answered for it. Once a retry answered some
 * of them, say which are still missing, so the error does not read as if the retry had failed.
 */
function errorText(run: AiRun, error: string): string {
	const hit = /^(?:(.+?): )?Request (\d+): /.exec(error)
	if (!hit || !run.evaluation) return error
	const member = hit[1] ? run.team?.members.find((m) => m.role === hit[1]) : undefined
	if (hit[1] && !member) return error
	const index = Number(hit[2]) - 1
	const owned = run.evaluation.filter((e) => (e.checkedBy ?? null) === (member?.id ?? null))
	const missing = owned.filter((e) => !e.answered?.includes(index))
	if (missing.length === 0 || missing.length === owned.length || owned.some((e) => !e.answered)) return error
	return `${error} — still missing: ${missing.map((e) => RULE_LABEL[e.rule]).join(', ')}`
}

const FACT_LABEL = {
	background: 'Background',
	project: 'Project context',
	ci: 'CI',
	dependencies: 'Dependencies',
	structure: 'Imports',
	decisions: 'Your earlier decisions',
	earlier: 'Earlier run',
} as const

/** Requests that must report on a rule: the owning member's share of a team run, or every request of a single-model run. */
function requestsFor(run: AiRun, memberId: string | null | undefined): number {
	const m = memberId ? run.team?.members.find((x) => x.id === memberId) : undefined
	return m ? m.requestsTotal : run.coverage.batchesTotal
}

const RULE_GROUPS: Array<{ title: string; rules: Array<ReviewRule> }> = [
	{ title: 'Defects', rules: ['bug', 'security', 'error-handling', 'performance', 'breaking-change'] },
	{ title: 'Structure', rules: ['file-split', 'over-engineered'] },
	{ title: 'Conventions', rules: ['convention', 'misleading-name'] },
	{ title: 'Tests', rules: ['test-value'] },
	{ title: 'Leftover code', rules: ['residue-1', 'residue-2', 'residue-3', 'residue-4', 'residue-5', 'residue-6'] },
]

/**
 * Every rule with its state, so "no findings" visibly means "checked, nothing qualified". A rule is ticked once every
 * request of the run has reported on it; each request answers all rules at once, so ticks advance request by request.
 */
function Checked({ run, onRetry }: { run: AiRun; onRetry: ((rules: Array<ReviewRule>) => void) | null }) {
	const [all, setAll] = useState(false)
	const ev = run.evaluation
	if (!ev) {
		return (
			<div className="small muted checklist-note">
				This run used the earlier review prompt, which did not report rule by rule. Run the review again to see every rule checked.
			</div>
		)
	}
	const running = run.status === 'running'
	const found = new Map<string, number>()
	for (const f of run.findings) {
		if (f.heldBack) continue
		const key = f.category === 'residue' ? `residue-${f.signature}` : (f.category ?? '')
		found.set(key, (found.get(key) ?? 0) + 1)
	}
	const byRule = new Map(ev.map((e) => [e.rule, e]))
	// A team member given no files has nothing to check; a run that sent no request at all checked nothing.
	const complete = (e: (typeof ev)[number]): boolean => {
		const need = requestsFor(run, e.checkedBy)
		return need > 0 ? e.requests >= need : run.coverage.batchesTotal > 0
	}
	const doneCount = ev.filter(complete).length
	const stateOf = (rule: StoredRule): 'found' | 'clear' | 'pending' | 'missing' => {
		const e = byRule.get(rule)!
		// A retry runs only its rules; the others it leaves incomplete stay missing rather than looking checked again.
		const checking = running && (!run.retrying || run.retrying.includes(rule as ReviewRule))
		return complete(e) ? ((found.get(rule) ?? 0) ? 'found' : 'clear') : checking ? 'pending' : 'missing'
	}
	// A finished run lists only the rules that need a look (findings, or not checked everywhere); the rest on request.
	const notable = ev.filter((e) => stateOf(e.rule) !== 'clear')
	const showAll = all || (running && !run.retrying)
	const withFindings = ev.filter((e) => stateOf(e.rule) === 'found').length
	const missing = ev.filter((e) => stateOf(e.rule) === 'missing').map((e) => e.rule)
	// Only current rules with requests to repeat can be retried; residue-7 of older runs is now part of test-value.
	const canRetry = (rule: StoredRule): boolean => requestsFor(run, byRule.get(rule)!.checkedBy) > 0
	const retryable = REVIEW_RULES.filter((r) => missing.includes(r) && canRetry(r))
	// A stopped run resumes by asking every rule it did not finish, even a single one.
	const stopped = run.status === 'cancelled'
	// Rules this run never asked (a bugs-only run, or rules added since) read as not checked, not as nothing found.
	const notAsked = RULE_GROUPS.flatMap((g) => g.rules).filter((r) => !byRule.has(r))
	return (
		<div className="checklist small" aria-live="polite">
			<div className="checklist-head">
				<b>Rules checked</b>
				<span className="muted">
					{doneCount} of {ev.length}
					{!running && withFindings ? ` · ${withFindings} with findings` : ''}
					{!running && missing.length ? ` · ${missing.length} not fully checked` : ''}
					{notAsked.length ? ` · ${notAsked.length} not part of this run` : ''}
					{running && run.coverage.batchesTotal > 1
						? ` · ${run.coverage.batchesDone} of ${run.coverage.batchesTotal} requests answered`
						: ''}
				</span>
				{retryable.length > (stopped ? 0 : 1) && onRetry && (
					<button
						className="btn small ghost check-retry checklist-retry-all"
						title={
							stopped
								? 'Continue this run: send the requests it did not get answers for, keeping the answers it already has'
								: 'Ask each reviewer again about all its rules that were not fully checked, on the requests that did not cover them'
						}
						onClick={() => onRetry(retryable)}
					>
						{stopped ? 'Resume' : 'Retry all'}
					</button>
				)}
				{!running && notable.length < ev.length + notAsked.length && (
					<button className="link checklist-toggle" onClick={() => setAll(!all)}>
						{all ? (notable.length ? 'Only rules to look at' : 'Hide rules') : `Show all ${ev.length + notAsked.length}`}
					</button>
				)}
			</div>
			{RULE_GROUPS.map((g) => ({ ...g, rules: g.rules.filter((r) => showAll || (byRule.has(r) && stateOf(r) !== 'clear')) }))
				.filter((g) => g.rules.length > 0)
				.map((g) => (
					<div key={g.title} className="checklist-group">
						<div className="checklist-title">{g.title}</div>
						{g.rules.map((rule) => {
							const e = byRule.get(rule)
							if (!e)
								return (
									<div key={rule} className="check-row skipped">
										<span className="check-icon" aria-hidden />
										<span className="check-label">{RULE_LABEL[rule]}</span>
										<span className="spacer" />
										<span className="muted nowrap check-status">not checked</span>
									</div>
								)
							const n = found.get(rule) ?? 0
							const need = requestsFor(run, e.checkedBy)
							const state = stateOf(rule)
							const status =
								(state === 'found'
									? `${n} finding${n === 1 ? '' : 's'}`
									: state === 'clear'
										? need === 0
											? 'no files for this rule'
											: 'nothing found'
										: state === 'pending'
											? need > 1
												? `${e.requests} of ${need}`
												: 'checking…'
											: `checked in ${e.requests} of ${need} requests`) +
								(e.nearMisses.length ? ` · ${e.nearMisses.length} near miss${e.nearMisses.length === 1 ? '' : 'es'}` : '')
							return (
								<details key={rule} className={`check-row ${state}`}>
									<summary>
										{state === 'pending' ? (
											<AiOrb activity="waiting" size={14} />
										) : (
											<span className="check-icon" aria-hidden>
												{state === 'clear' ? '✓' : state === 'found' ? '!' : '–'}
											</span>
										)}
										<span className="check-label">{RULE_LABEL[rule]}</span>
										{memberName(run, e.checkedBy) && <span className="check-by muted">{memberName(run, e.checkedBy)}</span>}
										<span className="spacer" />
										<span className="muted nowrap check-status" title={status}>
											{status}
										</span>
										{state === 'missing' && onRetry && canRetry(rule) && (
											<button
												className="btn small ghost check-retry"
												title={`Ask ${memberName(run, e.checkedBy) ?? 'the model'} again about this rule only, on the requests that did not cover it`}
												onClick={(ev) => {
													ev.preventDefault()
													onRetry([rule])
												}}
											>
												Retry
											</button>
										)}
									</summary>
									{(e.why.length > 0 || e.nearMisses.length > 0) && (
										<div className="check-detail">
											{e.why.map((w, i) => (
												<div key={i} className="muted">
													{w}
												</div>
											))}
											{e.nearMisses.length > 0 && (
												<ul>
													{e.nearMisses.map((m, i) => (
														<li key={i}>
															{m.fileKey && (
																<span className="mono">
																	{m.fileKey}
																	{m.line ? `:${m.line}` : ''}
																</span>
															)}{' '}
															{m.note}
														</li>
													))}
												</ul>
											)}
										</div>
									)}
								</details>
							)
						})}
					</div>
				))}
		</div>
	)
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<details>
			<summary>{title}</summary>
			<ul>{children}</ul>
		</details>
	)
}

interface CardProps {
	finding: Finding
	state: FindingState
	fixture: boolean
	team: AiRun['team']
	sameModel: boolean // the model that raised it also double-checked it
	discussed: Array<DiscussionThread> // threads on its lines, other than the one it says it raises again
	earlier: DiscussionThread | null // the thread it says it raises again, as read now
	screened: Array<string> // what in its text a person should read before posting (see screenFinding)
	selected: boolean
	focusAsk: number | null // changes each time the question box should open and take focus
	onOpen(): void
	onAccept(): void
	onDismiss(reason: DismissReason): void
	dismissMenu: boolean
	onToggleDismissMenu(): void
	decision: FindingDecision | null
	onNote(note: string): void
	onRestore(): void
	folded: Array<Finding> // the same problem at other places, folded under this one
	foldedUnder: string | null // the title of the finding this one was folded under, when shown on its own
	onShowSeparately(f: Finding): void
	onAsk(question: string): Promise<string | null>
	/** Double-checks it now; resolves with an error message, or null once the verdict is saved. */
	onVerify(): Promise<string | null>
	/** Writes a failing test for it; resolves with an error message, or null once the test is saved. */
	onWriteTest(): Promise<string | null>
	askDisabled: string | null
	askModelPicker: React.ReactNode
	timeline: Array<string> | null // the snapshots it was raised in, oldest first, when the run was compared with an earlier one
}

/** The snapshots a finding was raised in: "new" or "a1b2c3d → e4f5a6b → here". */
function Timeline({ heads, gone }: { heads: Array<string>; gone?: boolean }) {
	if (heads.length === 1 && !gone) return <span title="Not raised on the earlier snapshot this run was compared with"> · new</span>
	const shas = heads.map((h) => h.slice(0, 7))
	return (
		<span title="The snapshots it was raised in, oldest first">
			{' '}
			· raised on {gone ? shas.join(' → ') : [...shas.slice(0, -1), 'this snapshot'].join(' → ')}
		</span>
	)
}

/** A finding the earlier run raised and this run did not; it belongs to the earlier snapshot, so it can't be opened here. */
function GoneCard({
	gone: g,
	at,
	thread,
	onCheck,
	onResolve,
}: {
	gone: GoneFinding
	at: string
	thread: DiscussionThread | null
	onCheck: (() => Promise<string | null>) | null // null while the run is running
	onResolve?: (threadId: string) => Promise<string | null>
}) {
	const f = g.finding
	const meta = LEVEL_META[f.severity]
	const [busy, setBusy] = useState<'check' | 'resolve' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const act = async (kind: 'check' | 'resolve', call: () => Promise<string | null>): Promise<void> => {
		setBusy(kind)
		setError(null)
		setError(await call())
		setBusy(null)
	}
	const check = g.check && !g.check.error ? g.check : null
	// Only suggested, never done for you: a fixed finding whose comment's thread is still open on GitHub.
	const resolvable = g.state === 'fixed' && (!check || verdictOf(check) !== 'holds') && thread?.resolved === false && !!onResolve
	return (
		<div className={`finding-card gone ${g.state}`}>
			<div className="finding-open">
				<div className="ci-loc">
					<span className={`sev ${f.severity}`} title={meta.hint}>
						{meta.label}
					</span>
					{f.category && <span className="cat-tag">{CATEGORY_LABEL[f.category]}</span>}
					<span className="mono ellipsis">{anchorPath(f.anchor)}</span>
					<span className="muted small nowrap" title={`As it was on ${at.slice(0, 7)}`}>
						{anchorLabel(f.anchor)}
					</span>
				</div>
				<div className="finding-title">{f.title}</div>
			</div>
			<div className="ai-label small">
				<b title={g.state === 'fixed' ? FIXED_HINT : undefined}>{SINCE_LABEL[g.state]}:</b> {g.why}
				{g.comment ? ' You had added it as a comment.' : ''}
				<Timeline heads={findingTimeline(f, at)} gone />
			</div>
			{g.check && (
				<p className={`small ${check && verdictOf(check) === 'holds' ? 'warn-text' : ''}`}>
					<b>{!check ? 'Not checked' : CHECK_LABEL[verdictOf(check)]}:</b> <RefText text={g.check.reason} />{' '}
					{check?.unread?.length ? (
						<span className="warn-text">
							It <RefText text={unreadText(check.unread)} />.{' '}
						</span>
					) : null}
					<span className="muted">({g.check.model})</span>
				</p>
			)}
			{resolvable && (
				<p className="small">
					The GitHub thread of your comment on it is still open.{' '}
					{thread!.url && (
						<a href={thread!.url} target="_blank" rel="noreferrer">
							Open thread
						</a>
					)}
				</p>
			)}
			<div className="ask-actions">
				{onCheck && (
					<button
						className="btn small ghost"
						disabled={busy !== null}
						title="Asks the model whether the problem is still in the code as it is now. One request, counted towards your budgets."
						onClick={() => void act('check', onCheck)}
					>
						{busy === 'check' ? 'Checking…' : g.check ? 'Check again' : 'Check it’s fixed'}
					</button>
				)}
				{resolvable && (
					<button className="btn small ghost" disabled={busy !== null} onClick={() => void act('resolve', () => onResolve!(thread!.id))}>
						{busy === 'resolve' ? 'Resolving…' : 'Resolve thread'}
					</button>
				)}
				{error && <span className="small error-text">{error}</span>}
			</div>
			<details className="small">
				<summary>What it said</summary>
				{f.body !== undefined ? (
					<p className="finding-text selectable">
						<RefText text={f.body} />
					</p>
				) : (
					<p className="finding-text selectable">{f.problem}</p>
				)}
				<pre className="ci-excerpt">{f.evidence}</pre>
			</details>
		</div>
	)
}

// A check of a gone finding asks whether it is still there, so "wrong" means fixed.
const CHECK_LABEL: Record<FindingVerification['verdict'], string> = {
	wrong: 'Checked, fixed',
	holds: 'Checked, still there',
	unsure: 'Checked, not sure',
}

const REASON_LABEL: Record<DismissReason, string> = {
	wrong: 'Wrong',
	'not-worth-it': 'Not worth fixing',
	'handled-elsewhere': 'Handled elsewhere',
	intended: 'Intended',
}
const REASON_HINT: Record<DismissReason, string> = {
	wrong: 'The finding is incorrect. Later runs are told not to make the same mistake.',
	'not-worth-it': 'True, but not worth changing. Later runs skip problems of this kind and size here.',
	'handled-elsewhere': 'Something else already takes care of it. Say where in the note.',
	intended: 'The code is meant to work this way. Say why in the note.',
}

/** The reason and note of a dismissed finding; the note is told to later runs and can become a project note. */
function DismissedNote({ finding: f, decision, onNote }: { finding: Finding; decision: FindingDecision; onNote(note: string): void }) {
	const [text, setText] = useState(decision.note ?? '')
	const [copied, setCopied] = useState(false)
	useEffect(() => setText(decision.note ?? ''), [decision.note])
	const path = f.anchor.newPath ?? f.anchor.oldPath ?? f.anchor.fileKey
	const save = (): void => {
		if (text.trim() !== (decision.note ?? '')) onNote(text)
	}
	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(`- ${path}: ${text.trim()}`)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}
	return (
		<div className="dismissed-note small">
			<div>
				<b>Dismissed{decision.reason ? `: ${REASON_LABEL[decision.reason]}` : ''}.</b>{' '}
				<span className="muted">Later runs of this pull request or branch are told, so it is not raised again.</span>
			</div>
			<input
				placeholder={
					decision.reason === 'handled-elsewhere'
						? 'Where is it handled?'
						: decision.reason === 'intended'
							? 'Why is it intended?'
							: 'Note (optional)'
				}
				value={text}
				maxLength={500}
				onChange={(e) => {
					setText(e.target.value)
					setCopied(false)
				}}
				onBlur={save}
				onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
			/>
			{text.trim() && (
				<div className="muted">
					<button className="link" onClick={() => void copy()}>
						Copy as project note
					</button>
					{copied
						? ' Copied. Paste it into .review/context.md so every review of this repository knows it.'
						: ' for .review/context.md, which every review of this repository reads.'}
				</div>
			)}
		</div>
	)
}

// The check only tries to prove a finding wrong: failing to is not proof that it is right.
const VERDICT_LABEL = {
	holds: 'double-check: not disproved',
	wrong: 'double-check: likely wrong',
	unsure: 'double-check: not settled',
} as const

const SAME_MODEL_HINT =
	'The model that raised this finding also checked it. It knows what it knew then and can miss the same thing twice, so the check is weaker than one by another model.'

const VERDICT_WORD = { holds: 'not disproved', wrong: 'likely wrong', unsure: 'not settled' } as const

/** A test the AI wrote to show the finding: not run, so whether it fails is for you to find out. */
function Reproducer({ r }: { r: FindingReproducer }) {
	const [copied, setCopied] = useState(false)
	if (!r.code || !r.path)
		return (
			<div className={`reproducer small ${r.error ? 'error-text' : 'muted'}`}>
				<b>{r.error ? 'No test written.' : 'No test can show this:'}</b> {r.asserts.replace(/^No test written: /, '')}
			</div>
		)
	return (
		<details className="reproducer small" open>
			<summary>
				Failing test <span className="mono">{r.path}</span> <span className="muted">({r.model}, not run)</span>
			</summary>
			<p>{r.asserts}</p>
			<pre className="ci-excerpt selectable">{r.code}</pre>
			<button
				className="btn small ghost"
				onClick={() => {
					void navigator.clipboard.writeText(r.code!).then(() => {
						setCopied(true)
						setTimeout(() => setCopied(false), 1500)
					})
				}}
			>
				{copied ? 'Copied' : 'Copy test'}
			</button>
		</details>
	)
}

/** The double-check of a finding: a second request that tried to prove it wrong. */
function Verification({ v, by, sameModel, level }: { v: FindingVerification; by: string | null; sameModel: boolean; level: Severity }) {
	const verdict = verdictOf(v)
	const head = v.error
		? 'Not double-checked'
		: verdict === 'holds'
			? 'Double-check could not disprove it'
			: verdict === 'wrong'
				? 'Double-check says it is likely wrong (not added as a comment automatically)'
				: v.verdict === 'holds'
					? 'Double-check could not disprove it, but it rests on code it never read, so it is not settled'
					: 'Double-check could not settle it'
	return (
		<div className={`verification small ${v.error ? 'unsure' : verdict}`}>
			<b>
				{head}
				{by ? ` (checked by ${by})` : ''}.
			</b>{' '}
			{sameModel && (
				<>
					<span className="warn-text" title={SAME_MODEL_HINT}>
						Checked by the same model that raised it.
					</span>{' '}
				</>
			)}
			{v.error ? v.reason.replace(/^Not double-checked: /, '') : v.reason}
			{!v.error && v.unread?.length ? (
				<span className="warn-text">
					{' '}
					It <RefText text={unreadText(v.unread)} />.
				</span>
			) : null}
			{!v.error && v.level && v.verdict !== 'wrong' && v.level !== level ? ` Suggested level: ${LEVEL_META[v.level].label}.` : ''}
			{v.checked.length ? <span className="muted"> Read: {v.checked.join(', ')}.</span> : null}
			{v.earlier?.length ? (
				<div className="muted">
					Earlier: {v.earlier.map((e) => `${e.error ? 'not checked' : VERDICT_WORD[verdictOf(e)]} (${e.model})`).join(', ')}
				</div>
			) : null}
		</div>
	)
}

function FindingCard(p: CardProps) {
	const { finding: f, state, fixture, team, discussed, selected, onOpen, onAccept, onDismiss, onRestore } = p
	const ref = useRef<HTMLDivElement>(null)
	const [asking, setAsking] = useState(false)
	const [verifying, setVerifying] = useState(false)
	const [verifyError, setVerifyError] = useState<string | null>(null) // from Verify or Write failing test
	const [writing, setWriting] = useState(false)
	useEffect(() => {
		if (selected) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
	}, [selected])
	const meta = LEVEL_META[f.severity]
	return (
		<div
			ref={ref}
			className={`finding-card ${selected ? 'selected' : ''} ${state} ${f.verification?.verdict === 'wrong' ? 'refuted' : ''}`}
		>
			<button className="finding-open" onClick={onOpen} title="Open in diff">
				<div className="ci-loc">
					<span className={`sev ${f.severity}`} title={meta.hint}>
						{meta.label}
					</span>
					{f.category && (
						<span
							className="cat-tag"
							title={
								f.category === 'residue' && f.signature
									? RESIDUE_LABEL[f.signature]
									: f.category === 'test-value' && f.testPattern
										? TEST_PATTERN_LABEL[f.testPattern]
										: undefined
							}
						>
							{f.category === 'test-value' && f.testPattern ? `Test · ${TEST_PATTERN_LABEL[f.testPattern]}` : CATEGORY_LABEL[f.category]}
						</span>
					)}
					<span className="mono ellipsis">{anchorPath(f.anchor)}</span>
					<span className="muted small nowrap">{anchorLabel(f.anchor)}</span>
				</div>
				<div className="finding-title">{f.title}</div>
			</button>
			<div className="ai-label small">
				{fixture ? 'Fixture output' : 'AI suggestion'} · location verified,{' '}
				{f.verification && !f.verification.error ? VERDICT_LABEL[verdictOf(f.verification)] : 'claim not verified'}
				{p.sameModel ? <span title={SAME_MODEL_HINT}>, checked by the same model</span> : null}
				{f.support?.some((s) => s.strength === 'flags') ? ' · CI flagged these lines too' : ''}
				{team && f.memberId ? ` · ${team.members.find((m) => m.id === f.memberId)?.role ?? 'reviewer'}` : ''}
				{team && f.alsoBy?.length
					? `, also ${f.alsoBy.map((id) => team.members.find((m) => m.id === id)?.role ?? 'another reviewer').join(', ')}`
					: ''}
				{f.repeatOf ? ' · also reported by an earlier run' : ''}
				{f.carried ? ` · carried from the run on ${f.carried.from.headSha.slice(0, 7)}, the file's diff is unchanged` : ''}
				{p.timeline && <Timeline heads={p.timeline} />}
			</div>
			{p.screened.length > 0 && (
				<div className="discussed-note raised-note rejected small" title="Automatic review doesn't post a finding like this.">
					<b>Read before posting:</b> its text has {p.screened.join(', ')}. The AI read pull request text anyone can write.
				</div>
			)}
			{f.unread?.length ? (
				<div
					className="discussed-note raised-note rejected small"
					title="Checked against the code, related code and lookups the request that raised it had. Its level and place in the list are unchanged."
				>
					<b>Unread citation:</b> it <RefText text={unreadText(f.unread)} />, so that part is a guess, not something it checked.
				</div>
			) : null}
			{f.raisedBefore && <RaisedBeforeNote r={f.raisedBefore} thread={p.earlier} />}
			<AlreadyDiscussed threads={discussed} unclaimed />
			{f.body !== undefined ? (
				<div className="finding-body">
					<p className="finding-text selectable">
						<RefText text={f.body} />
					</p>
					{f.reasoning && (
						<p className="small muted">
							<b>Why flagged:</b> <RefText text={f.reasoning} />
						</p>
					)}
					{f.disproof && (
						<p className="small">
							<b>Would prove it wrong:</b> <RefText text={f.disproof} />
						</p>
					)}
					{f.background && (
						<details className="small">
							<summary>Background</summary>
							<p>
								<RefText text={f.background} />
							</p>
						</details>
					)}
					<pre className="ci-excerpt">{f.evidence}</pre>
					{p.folded.length > 0 && (
						<div className="folded small">
							<b>Same problem also at:</b>
							{p.folded[0].mergedReason && <span className="muted"> {p.folded[0].mergedReason}</span>}
							<ul>
								{p.folded.map((x) => (
									<li key={x.id}>
										<span className="mono">
											{anchorPath(x.anchor)} {anchorLabel(x.anchor)}
										</span>{' '}
										{x.title}{' '}
										<button className="link" onClick={() => p.onShowSeparately(x)}>
											Show separately
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					{p.foldedUnder && (
						<p className="small muted">
							Was grouped with “{p.foldedUnder}” as the same problem{f.mergedReason ? `: ${f.mergedReason}` : '.'} Shown on its own.
						</p>
					)}
					{f.verification && (
						<Verification
							v={f.verification}
							sameModel={p.sameModel}
							level={f.severity}
							by={
								team && f.verification.memberId
									? `${team.members.find((m) => m.id === f.verification!.memberId)?.role ?? 'another reviewer'} · ${f.verification.model}`
									: f.verification.onDemand
										? f.verification.model
										: null
							}
						/>
					)}
					{f.support?.length ? (
						<ul className="support small">
							{f.support.map((s, i) => (
								<li key={i} className={s.strength}>
									<b>{s.source === 'ci' ? 'CI' : 'Tests'}:</b> {s.text}
								</li>
							))}
						</ul>
					) : null}
					{f.adjusted && <p className="small warn-text">{f.adjusted}</p>}
					{f.heldBack && <p className="small muted">{f.heldBack}</p>}
				</div>
			) : (
				<dl className="finding-body">
					<dt>Problem</dt>
					<dd>
						<RefText text={f.problem ?? ''} />
					</dd>
					<dt>Consequence</dt>
					<dd>
						<RefText text={f.consequence ?? ''} />
					</dd>
					<dt>Evidence</dt>
					<dd>
						<pre className="ci-excerpt">{f.evidence}</pre>
					</dd>
					<dt>Suggestion</dt>
					<dd>
						<RefText text={f.suggestion ?? ''} />
					</dd>
				</dl>
			)}
			{(!!f.thread?.length || asking) && <Thread messages={f.thread ?? []} pending={asking} />}
			<AskBox key={f.id} focus={p.focusAsk} disabled={p.askDisabled} onBusy={setAsking} onAsk={p.onAsk} modelPicker={p.askModelPicker} />
			<div className="finding-actions">
				{state === 'open' && (
					<>
						<button
							className="btn small ghost"
							onClick={p.onToggleDismissMenu}
							aria-expanded={p.dismissMenu}
							title={keyLabel('findingDismiss') ? `Dismiss (${keyLabel('findingDismiss')})` : 'Dismiss'}
						>
							Dismiss ▾
						</button>
						<button
							className="btn small primary"
							onClick={onAccept}
							title={keyLabel('findingAccept') ? `Add to review (${keyLabel('findingAccept')})` : 'Add to review'}
						>
							Add to review
						</button>
					</>
				)}
				{state === 'accepted' && (
					<button className="btn small" onClick={onAccept}>
						Show comment
					</button>
				)}
				{state === 'dismissed' && (
					<button className="btn small" onClick={onRestore}>
						Restore
					</button>
				)}
				<button
					className="btn small ghost"
					disabled={verifying || p.askDisabled !== null}
					title={
						p.askDisabled ??
						'Ask a model to try to prove this finding wrong, reading the code around it. Uses the model for questions, else the one that raised it.'
					}
					onClick={() => {
						setVerifying(true)
						setVerifyError(null)
						void p.onVerify().then((err) => {
							setVerifying(false)
							setVerifyError(err)
						})
					}}
				>
					{verifying ? 'Verifying…' : f.verification && !f.verification.error ? 'Verify again' : 'Verify'}
				</button>
				<button
					className="btn small ghost"
					disabled={writing || p.askDisabled !== null}
					title={
						p.askDisabled ??
						'Ask a model for a test in the project’s style that fails while this finding holds. It is shown here to copy; nothing is saved to disk or run.'
					}
					onClick={() => {
						setWriting(true)
						setVerifyError(null)
						void p.onWriteTest().then((err) => {
							setWriting(false)
							setVerifyError(err)
						})
					}}
				>
					{writing ? 'Writing test…' : f.reproducer?.code ? 'Write test again' : 'Write failing test'}
				</button>
			</div>
			{verifyError && <p className="error-text small">{verifyError}</p>}
			{f.reproducer && <Reproducer r={f.reproducer} />}
			{state === 'open' && p.dismissMenu && (
				<div className="dismiss-menu small" role="group" aria-label="Why dismiss it?">
					<span className="muted">Why?</span>
					{DISMISS_REASONS.map((r, i) => (
						<button key={r} className="btn small ghost" onClick={() => onDismiss(r)} title={REASON_HINT[r]}>
							<kbd>{i + 1}</kbd> {REASON_LABEL[r]}
						</button>
					))}
				</div>
			)}
			{state === 'dismissed' && p.decision?.status === 'dismissed' && <DismissedNote finding={f} decision={p.decision} onNote={p.onNote} />}
			{!!p.decision?.history?.length && (
				<div className="small muted">
					Earlier:{' '}
					{p.decision.history
						.map(
							(h) =>
								`${h.status === 'dismissed' ? `dismissed${h.reason ? ` (${REASON_LABEL[h.reason]})` : ''}${h.note ? `: "${h.note}"` : ''}` : 'restored'} ${new Date(h.decidedAt).toLocaleString()}`,
						)
						.join(' · ')}
				</div>
			)}
		</div>
	)
}

const VERDICT_TEXT: Record<'holds' | 'wrong' | 'unsure', { label: string; hint: string }> = {
	holds: { label: 'Still holds', hint: 'The model still thinks the finding is right' },
	wrong: { label: 'Finding is wrong', hint: 'The model agrees it is not a problem. You can dismiss it, or delete its comment.' },
	unsure: { label: 'Unsure', hint: 'The supplied code was not enough to settle it' },
}

function Thread({ messages, pending }: { messages: Array<FindingMessage>; pending: boolean }) {
	return (
		<div className="finding-thread" aria-live="polite">
			{messages.map((m) => (
				<div key={m.id} className={`thread-msg ${m.role}${m.error ? ' error' : ''}`}>
					{m.role === 'ai' && (
						<div className="thread-meta">
							<span>{m.model ?? 'AI'}</span>
							{m.verdict && (
								<span className={`verdict ${m.verdict}`} title={VERDICT_TEXT[m.verdict].hint}>
									{VERDICT_TEXT[m.verdict].label}
								</span>
							)}
							{m.verdict !== 'wrong' && m.level && (
								<span title="The level the model would give the finding now">
									{LEVEL_META[m.level].emoji} {LEVEL_META[m.level].label}
								</span>
							)}
						</div>
					)}
					<span className="selectable">{m.text}</span>
				</div>
			))}
			{pending && messages[messages.length - 1]?.role !== 'you' && <div className="thread-msg you muted">Sending…</div>}
			{pending && (
				<div className="thread-msg ai muted">
					<AiOrb activity="reasoning" size={14} /> Thinking…
				</div>
			)}
		</div>
	)
}

interface AskProps {
	focus: number | null
	disabled: string | null
	onBusy(busy: boolean): void
	onAsk(question: string): Promise<string | null>
	modelPicker: React.ReactNode
}

function AskBox({ focus, disabled, onBusy, onAsk, modelPicker }: AskProps) {
	const [open, setOpen] = useState(focus !== null)
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => {
		if (focus === null) return
		setOpen(true)
		requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
	}, [focus])
	const send = async (): Promise<void> => {
		const q = text.trim()
		if (!q || busy) return
		setBusy(true)
		onBusy(true)
		setError(null)
		const problem = await onAsk(q)
		setBusy(false)
		onBusy(false)
		if (problem) setError(problem)
		else setText('')
	}
	if (!open)
		return (
			<div className="ask-box">
				<button
					className="btn small ghost"
					onClick={() => setOpen(true)}
					disabled={!!disabled}
					title={disabled ?? 'Ask the model that raised this finding'}
				>
					Ask AI about this finding
				</button>
			</div>
		)
	return (
		<div className="ask-box">
			<textarea
				ref={ref}
				value={text}
				rows={2}
				placeholder="Ask about this finding, e.g. “This component is never unmounted. Does the problem still apply?”"
				disabled={busy}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault()
						void send()
					} else if (e.key === 'Escape' && !text) setOpen(false)
				}}
			/>
			{error && <p className="small error-text">{error}</p>}
			<div className="ask-actions">
				<span className="muted small">With the code around it · ⌘↵ to send</span>
				<span className="spacer" />
				{modelPicker}
				<button
					className="btn small primary"
					onClick={() => void send()}
					disabled={!text.trim() || busy || !!disabled}
					title={disabled ?? undefined}
				>
					{busy ? 'Asking…' : 'Ask'}
				</button>
			</div>
		</div>
	)
}

function lensNote(persona: string | null | undefined): string {
	const p = personaOf(persona)
	return p ? ` · ${p.name} lens` : ''
}
