import { useEffect, useRef, useState } from 'react'
import type { AiRun, AiSettingsView, AiStartScope, ChangedFile, IncrementalOffer, ReviewerChoice, RunEstimate } from '../../shared/types.ts'
import { formatCostRange, formatTokenRange } from '../../shared/cost.ts'
import { RULE_LABEL } from './FindingsPanel.tsx'
import { sourceTitle } from './ModelPicker.tsx'
import { AiOrb } from './AiOrb.tsx'
import { personaOf, REVIEW_PERSONAS, type PersonaId } from '../../shared/personas.ts'

interface Props {
	settings: AiSettingsView | null
	reviewer: ReviewerChoice
	activeRun: AiRun | null
	currentFile: ChangedFile | null
	fileCount: number
	unviewed: Array<string> // keys of the changed files not marked viewed, in tree order
	/** Whether this reviewer can review only the files changed since the last finished run; null when there is none. */
	loadOffer(reviewer: ReviewerChoice): Promise<IncrementalOffer | null>
	/** What a run with these options would send and cost; null when it can't be worked out. */
	loadEstimate(reviewer: ReviewerChoice, scope: AiStartScope): Promise<RunEstimate | null>
	openNow?: boolean // open the dialog once (a pull request link opened this review); onOpened clears it
	onOpened?(): void
	onStart(scope: AiStartScope, passes: boolean, bugsOnly: boolean, persona: PersonaId | null, overBudget: boolean): void
	onCancel(): void
}

/** Header control: opens a confirmation popover showing scope, provider and model; nothing is sent before "Start". */
export function AiRunControl({
	settings,
	reviewer,
	activeRun,
	currentFile,
	fileCount,
	unviewed,
	loadOffer,
	loadEstimate,
	openNow,
	onOpened,
	onStart,
	onCancel,
}: Props) {
	const selection = reviewer.kind === 'model' ? reviewer.selection : null
	const team = reviewer.kind === 'team' ? settings?.teams.find((t) => t.id === reviewer.teamId) : undefined
	const [open, setOpen] = useState(false)
	// Null until you pick one: then only the changed files when an earlier run can be built on, else all files.
	const [scope, setScope] = useState<'changed' | 'file' | 'unviewed' | 'all' | null>(null)
	const [passes, setPasses] = useState(readPasses)
	// Not remembered: a partial review should never be the default without anyone noticing.
	const [bugsOnly, setBugsOnly] = useState(false)
	const [persona, setPersona] = useState(readPersona)
	const [offer, setOffer] = useState<IncrementalOffer | null>(null)
	const [estimate, setEstimate] = useState<{ key: string; value: RunEstimate | null } | null>(null)
	const ref = useRef<HTMLDivElement>(null)
	const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

	// The header clips overflow, so the popover is positioned against the viewport.
	function place(): void {
		const rect = ref.current?.getBoundingClientRect()
		if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
	}
	function toggle(): void {
		place()
		setOpen((x) => !x)
	}

	const running = activeRun?.status === 'running'
	useEffect(() => {
		if (!openNow) return
		if (!running && fileCount > 0) {
			place()
			setOpen(true)
		}
		onOpened?.()
	}, [openNow, running, fileCount, onOpened])

	useEffect(() => {
		if (!open) return
		function onDown(e: MouseEvent): void {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') setOpen(false)
		}
		window.addEventListener('mousedown', onDown)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('mousedown', onDown)
			window.removeEventListener('keydown', onKey)
		}
	}, [open])

	// Asked again whenever the options change: a run with other rules or another model can't carry the earlier results.
	const choice: ReviewerChoice = reviewer.kind === 'model' ? { ...reviewer, passes, bugsOnly, persona } : reviewer
	const choiceKey = JSON.stringify(choice)
	// Another review, or a run finished: the old answer is stale.
	useEffect(() => setOffer(null), [loadOffer])
	useEffect(() => {
		if (!open) return
		let live = true
		void loadOffer(JSON.parse(choiceKey) as ReviewerChoice).then((o) => {
			if (live) setOffer(o)
		})
		return () => {
			live = false
		}
	}, [open, choiceKey, loadOffer])

	// Every file unviewed is the same run as all files; none unviewed has nothing to send.
	const unviewedOnly = unviewed.length > 0 && unviewed.length < fileCount
	const incremental = offer && offer.refused === null ? offer : null
	const picked = scope ?? (incremental ? 'changed' : 'all')
	const effectiveScope =
		(picked === 'file' && !currentFile) || (picked === 'unviewed' && !unviewedOnly) || (picked === 'changed' && !incremental)
			? 'all'
			: picked
	const startScope: AiStartScope =
		effectiveScope === 'changed'
			? { kind: 'changed' }
			: effectiveScope === 'file' && currentFile
				? { kind: 'file', fileKey: currentFile.key }
				: effectiveScope === 'unviewed'
					? { kind: 'files', fileKeys: unviewed }
					: { kind: 'all' }
	const estimateKey = JSON.stringify([choice, startScope])
	useEffect(() => {
		if (!open || running) return
		let live = true
		const [c, sc] = JSON.parse(estimateKey) as [ReviewerChoice, AiStartScope]
		void loadEstimate(c, sc).then((value) => {
			if (live) setEstimate({ key: estimateKey, value })
		})
		return () => {
			live = false
		}
	}, [open, running, estimateKey, loadEstimate])
	const shown = estimate?.key === estimateKey ? estimate.value : undefined

	if (activeRun && activeRun.status === 'running') {
		const c = activeRun.coverage
		const finished = c.batchesDone + c.batchesFailed
		const v = activeRun.verification
		const checking = v && v.done + v.failed < v.total ? v : null
		return (
			<span
				className="ai-progress"
				role="status"
				aria-live="polite"
				title={`${activeRun.team ? activeRun.team.name : 'AI review'} running. The Findings tab shows each reviewer's progress.`}
			>
				{/* Before the first request the app gathers related code and CI results; then the model reviews. */}
				<AiOrb activity={c.batchesTotal ? 'reasoning' : 'searching'} size={16} />
				<span className="small nowrap">
					{checking
						? `Checking ${checking.done + checking.failed + 1}/${checking.total}`
						: c.batchesTotal
							? `${finished}/${c.batchesTotal}`
							: 'Preparing…'}
					{activeRun.findings.length ? ` · ${activeRun.findings.length} found` : ''}
				</span>
				<button className="btn small ghost" onClick={onCancel} title="Stop this run. Answers that already arrived are kept.">
					Stop
				</button>
			</span>
		)
	}

	const connection = selection ? settings?.connections.find((c) => c.id === selection.connectionId) : undefined
	const model = connection?.models.find((m) => m.id === selection?.modelId)
	const fixture = connection?.kind === 'fixture'
	const local = connection ? /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connection.baseUrl) : false
	const problem = team
		? (team.issues[0]?.message ?? null)
		: reviewer.kind === 'team'
			? 'That review team no longer exists. Choose a model or team.'
			: !connection || !model
				? (settings?.selectionIssue ?? 'Choose a model first.')
				: connection.status !== 'connected' && !fixture
					? (connection.statusDetail ?? `${connection.label} is not connected.`)
					: null
	const teamConnections = team ? team.members.map((m) => settings?.connections.find((c) => c.id === m.connectionId)) : []
	const limits = settings?.limits
	return (
		<div className="ai-control" ref={ref}>
			<button className="btn" onClick={toggle} aria-expanded={open} disabled={fileCount === 0}>
				Run AI review…
			</button>
			{open && (
				<div className="popover" role="dialog" aria-label="Run AI review" style={anchor ?? undefined}>
					<div className="popover-title">Run AI review</div>
					<div className="seg soft" role="radiogroup" aria-label="Scope">
						{incremental && (
							<button
								role="radio"
								aria-checked={effectiveScope === 'changed'}
								className={effectiveScope === 'changed' ? 'on' : ''}
								title={`Only the files whose diff changed since the run on ${incremental.from.headSha.slice(0, 7)}; that run's results are kept for the rest`}
								onClick={() => setScope('changed')}
							>
								Changed ({incremental.review.length})
							</button>
						)}
						<button
							role="radio"
							aria-checked={effectiveScope === 'all'}
							className={effectiveScope === 'all' ? 'on' : ''}
							title="Binary and unchanged-content files are skipped"
							onClick={() => setScope('all')}
						>
							All {fileCount} file{fileCount === 1 ? '' : 's'}
						</button>
						<button
							role="radio"
							aria-checked={effectiveScope === 'unviewed'}
							className={effectiveScope === 'unviewed' ? 'on' : ''}
							title={
								unviewedOnly
									? 'Only the files you have not marked viewed'
									: unviewed.length
										? 'No file is marked viewed yet'
										: 'Every file is marked viewed'
							}
							disabled={!unviewedOnly}
							onClick={() => setScope('unviewed')}
						>
							Unviewed ({unviewed.length})
						</button>
						<button
							role="radio"
							aria-checked={effectiveScope === 'file'}
							className={effectiveScope === 'file' ? 'on' : ''}
							title={currentFile ? (currentFile.newPath ?? currentFile.oldPath ?? undefined) : 'No file selected'}
							disabled={!currentFile}
							onClick={() => setScope('file')}
						>
							Current file
						</button>
					</div>
					{effectiveScope === 'changed' && incremental ? (
						<p className="muted small">
							{incremental.review.length
								? `Reviews ${incremental.review.length} changed file${incremental.review.length === 1 ? '' : 's'}. `
								: 'No diff changed, so nothing is sent. '}
							{incremental.recheck.length > 0 && (
								<>
									{incremental.recheck.length === 1
										? 'One of them didn’t change but uses'
										: `${incremental.recheck.length} of them didn’t change but use`}{' '}
									names whose definitions did:{' '}
									{incremental.recheck.slice(0, 3).map((r, i) => (
										<span key={r.fileKey}>
											{i ? ', ' : ''}
											<span className="mono">{r.fileKey}</span> ({r.names.slice(0, 3).join(', ')})
										</span>
									))}
									{incremental.recheck.length > 3 ? '…' : ''}.{' '}
								</>
							)}
							{incremental.carry.length} file{incremental.carry.length === 1 ? '' : 's'} keep{incremental.carry.length === 1 ? 's' : ''} the
							findings and decisions of the run on <span className="mono">{incremental.from.headSha.slice(0, 7)}</span>.
						</p>
					) : (
						offer?.refused && effectiveScope === 'all' && <p className="muted small">Reviews every file again: {offer.refused}</p>
					)}
					{team ? (
						<ul className="team-members small" title="Each reviewer checks only its rules, all at the same time">
							{team.members.map((m, i) => (
								<li
									key={m.id}
									className="ellipsis"
									title={`${teamConnections[i]?.label ?? '?'} · ${m.modelId}\n${m.rules.map((r) => RULE_LABEL[r]).join(', ')}`}
								>
									<b>{m.role}</b> <span className="muted mono">{m.modelId}</span>
								</li>
							))}
						</ul>
					) : (
						<>
							<div className="small ellipsis">
								{connection?.label ?? '—'} · <span className="mono">{model?.id ?? '—'}</span>
								{fixture && <span className="pill warn">Fixture</span>}
							</div>
							<label
								className="option passes"
								title="Run this model once per role (defects, security, callers, tests), each on only the files its rules apply to. Sharper, but uses more tokens."
							>
								<input
									type="checkbox"
									checked={passes}
									onChange={(e) => {
										setPasses(e.target.checked)
										savePasses(e.target.checked)
									}}
								/>
								<span>Focused passes</span>
							</label>
							<label
								className="option passes"
								title="Check only bugs and security, skipping conventions, naming, leftover code and test value. Uses fewer tokens; the other rules show as not checked. Applies to this run only."
							>
								<input type="checkbox" checked={bugsOnly} onChange={(e) => setBugsOnly(e.target.checked)} />
								<span>Bugs &amp; security only</span>
							</label>
							<label className="option lens" title={lensTitle(persona)}>
								<span>Lens</span>
								<select
									value={persona ?? ''}
									onChange={(e) => {
										const id = personaOf(e.target.value)?.id ?? null
										setPersona(id as PersonaId | null)
										savePersona(id)
									}}
								>
									<option value="">None</option>
									{REVIEW_PERSONAS.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name}
										</option>
									))}
								</select>
							</label>
						</>
					)}
					<RunCost estimate={shown} />
					<details className="run-info small">
						<summary>What gets sent</summary>
						<dl className="ai-meta" hidden={!!team}>
							<dt>Provider</dt>
							<dd>
								{connection ? connection.label : '—'}
								{connection && connection.label !== connection.providerLabel && <span className="muted">({connection.providerLabel})</span>}
								{fixture && <span className="pill warn">Fixture</span>}
							</dd>
							<dt>Model</dt>
							<dd className="mono" title={model ? sourceTitle(model) : undefined}>
								{model?.id ?? '—'}
							</dd>
							{connection && !fixture && (
								<>
									<dt>Endpoint</dt>
									<dd className="mono ellipsis">{connection.baseUrl}</dd>
								</>
							)}
							<dt>Prompt</dt>
							<dd className="mono">{settings?.promptVersion ?? '…'}</dd>
							<dt>Limits</dt>
							<dd>
								{limits
									? `${limits.contextLines} context lines, up to ${limits.maxBatchChars.toLocaleString()} chars per request (reduced to fit the model), ${limits.maxRunChars.toLocaleString()} per run${limits.relatedCode ? ', with related code' : ''}${limits.lookups ? ', with lookups' : ''}`
									: '…'}
							</dd>
						</dl>
						<p className="muted small">
							{team
								? `Only the numbered diff and nearby source from the pinned commits${limits?.relatedCode ? ', plus related code from other files (definitions and uses of the changed names),' : ''} are sent to the ${team.members.length} reviewers (${[...new Set(teamConnections.map((c) => c?.label))].join(', ')}), each getting only the files its rules apply to. Dependency changes also get facts computed from package.json and the lock file, and the head commit’s CI results are read from GitHub and included.${limits?.lookups ? ' Each reviewer can also open files and search the code in the pinned commits while it reviews.' : ''}`
								: fixture
									? 'The fixture provider returns deterministic sample findings. Nothing leaves this computer.'
									: `Only the numbered diff and nearby source from the pinned commits${limits?.relatedCode ? ', plus related code from other files (definitions and uses of the changed names),' : ''} are sent${local ? ' to this local server' : ` to ${connection?.label ?? 'the provider'}`}. Dependency changes also get facts computed from package.json and the lock file, and the head commit’s CI results are read from GitHub and included.${limits?.lookups ? ' The model can also open files and search the code in the pinned commits while it reviews.' : ''} Uncommitted changes are not included.`}{' '}
							{team ? 'Each reviewer’s model stays fixed for this run.' : 'The provider and model stay fixed for this run.'} Results are
							suggestions; they never mark files as viewed.
						</p>
					</details>
					{shown && shown.unbudgeted.length > 0 && (
						<p className="muted small">
							{shown.unbudgeted.length === 1 ? (
								<>
									<span className="mono">{shown.unbudgeted[0]}</span> has no price, so your budgets don’t limit it.
								</>
							) : (
								<>
									{shown.unbudgeted.map((m, i) => (
										<span key={m}>
											{i ? ', ' : ''}
											<span className="mono">{m}</span>
										</span>
									))}{' '}
									have no price, so your budgets don’t limit them.
								</>
							)}{' '}
							Set a price in Settings → AI providers to include {shown.unbudgeted.length === 1 ? 'it' : 'them'}.
						</p>
					)}
					{shown && shown.over.length > 0 && (
						<p className="notice small" role="alert">
							{shown.over.join(' ')} Starting this review goes over it.
						</p>
					)}
					{problem && <p className="error-text small">{problem}</p>}
					<div className="popover-actions">
						<button className="btn small ghost" onClick={() => setOpen(false)}>
							Cancel
						</button>
						<button
							className="btn small primary"
							disabled={problem !== null}
							onClick={() => {
								setOpen(false)
								onStart(startScope, !team && passes, !team && bugsOnly, team ? null : persona, !!shown?.over.length)
							}}
						>
							{shown?.over.length ? 'Start anyway' : 'Start review'}
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

/** The estimate before a run: undefined while it is worked out, null when it couldn't be. */
function RunCost({ estimate: e }: { estimate: RunEstimate | null | undefined }) {
	if (e === undefined) return <p className="muted small run-cost">Estimating cost…</p>
	if (e === null || e.requests === 0) return null
	return (
		<div className="small run-cost" title={e.notes.join('\n') || undefined}>
			<div>
				<b>
					{e.cost
						? `${e.cost.unpriced ? 'At least ' : ''}${formatCostRange(e.cost.low, e.cost.high)}${e.cost.estimated ? ' est.' : ''}`
						: 'Cost unknown'}
				</b>{' '}
				<span className="muted">
					· {formatTokenRange(e.inputTokens)} tokens in, {formatTokenRange(e.outputTokens)} out · {e.requests} request
					{e.requests === 1 ? '' : 's'}
				</span>
			</div>
			{e.notes.length > 0 && (
				<ul className="muted run-cost-notes">
					{e.notes.map((n) => (
						<li key={n}>{n}</li>
					))}
				</ul>
			)}
		</div>
	)
}

// The focused-passes choice is a per-viewer convenience: kept in this browser only, off when storage is unavailable.
const PASSES_KEY = 'review.focusedPasses'

function readPasses(): boolean {
	try {
		return localStorage.getItem(PASSES_KEY) === '1'
	} catch {
		return false
	}
}

// The lens is remembered the same way; an id from an older version that no longer exists reads as none.
const PERSONA_KEY = 'review.persona'

function readPersona(): PersonaId | null {
	try {
		return (personaOf(localStorage.getItem(PERSONA_KEY))?.id ?? null) as PersonaId | null
	} catch {
		return null
	}
}

function savePersona(id: string | null): void {
	try {
		localStorage.setItem(PERSONA_KEY, id ?? '')
	} catch {
		// Not remembered; the run still uses the current choice.
	}
}

function lensTitle(id: PersonaId | null): string {
	const p = personaOf(id)
	return p
		? `${p.summary}\nInspired by ${p.inspiredBy}. The model still checks every rule; the lens only says where to look harder.`
		: 'Review with a persona’s focus. It adds no rules: the model still checks every rule and only looks harder where the lens says.'
}

function savePasses(on: boolean): void {
	try {
		localStorage.setItem(PASSES_KEY, on ? '1' : '0')
	} catch {
		// Not remembered; the run still uses the current choice.
	}
}
