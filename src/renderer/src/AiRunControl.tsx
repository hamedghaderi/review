import { useEffect, useRef, useState } from 'react'
import type { AiRun, AiScope, AiSettingsView, ChangedFile, ReviewerChoice } from '../../shared/types.ts'
import { RULE_LABEL } from './FindingsPanel.tsx'
import { sourceTitle } from './ModelPicker.tsx'
import { AiOrb } from './AiOrb.tsx'

interface Props {
	settings: AiSettingsView | null
	reviewer: ReviewerChoice
	activeRun: AiRun | null
	currentFile: ChangedFile | null
	fileCount: number
	onStart(scope: AiScope, passes: boolean): void
	onCancel(): void
}

/** Header control: opens a confirmation popover showing scope, provider and model; nothing is sent before "Start". */
export function AiRunControl({ settings, reviewer, activeRun, currentFile, fileCount, onStart, onCancel }: Props) {
	const selection = reviewer.kind === 'model' ? reviewer.selection : null
	const team = reviewer.kind === 'team' ? settings?.teams.find((t) => t.id === reviewer.teamId) : undefined
	const [open, setOpen] = useState(false)
	const [scope, setScope] = useState<'file' | 'all'>('all')
	const [passes, setPasses] = useState(readPasses)
	const ref = useRef<HTMLDivElement>(null)
	const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

	// The header clips overflow, so the popover is positioned against the viewport.
	function toggle(): void {
		const rect = ref.current?.getBoundingClientRect()
		if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
		setOpen((x) => !x)
	}

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

	const effectiveScope: 'file' | 'all' = scope === 'file' && !currentFile ? 'all' : scope
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
					<fieldset className="scope-choice">
						<label>
							<input
								type="radio"
								name="ai-scope"
								checked={effectiveScope === 'file'}
								disabled={!currentFile}
								onChange={() => setScope('file')}
							/>
							<span>
								Current file
								<span className="muted small mono ellipsis block">
									{currentFile ? (currentFile.newPath ?? currentFile.oldPath) : 'No file selected'}
								</span>
							</span>
						</label>
						<label>
							<input type="radio" name="ai-scope" checked={effectiveScope === 'all'} onChange={() => setScope('all')} />
							<span>
								All changed files
								<span className="muted small block">
									{fileCount} file{fileCount === 1 ? '' : 's'}; binary and unchanged-content files are skipped
								</span>
							</span>
						</label>
					</fieldset>
					{!team && (
						<label className="option passes">
							<input
								type="checkbox"
								checked={passes}
								onChange={(e) => {
									setPasses(e.target.checked)
									savePasses(e.target.checked)
								}}
							/>
							<span>
								<span>Focused passes</span>
								<span className="muted small">
									Run this model once per role (defects, security, callers, tests), each on only the files its rules apply to. Sharper, but
									uses more tokens.
								</span>
							</span>
						</label>
					)}
					{team ? (
						<div className="small team-summary">
							<div>
								<b>{team.name}</b> <span className="muted">· each reviewer checks only its rules, all at the same time</span>
							</div>
							<ul className="team-members">
								{team.members.map((m, i) => (
									<li key={m.id}>
										<b>{m.role}</b>
										<div className="muted mono ellipsis" title={`${teamConnections[i]?.label ?? '?'} · ${m.modelId}`}>
											{teamConnections[i]?.label ?? '?'} · {m.modelId}
										</div>
										<div className="muted">{m.rules.map((r) => RULE_LABEL[r]).join(', ')}</div>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<dl className="ai-meta small" hidden={!!team}>
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
								onStart(
									effectiveScope === 'file' && currentFile ? { kind: 'file', fileKey: currentFile.key } : { kind: 'all' },
									!team && passes,
								)
							}}
						>
							Start review
						</button>
					</div>
				</div>
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

function savePasses(on: boolean): void {
	try {
		localStorage.setItem(PASSES_KEY, on ? '1' : '0')
	} catch {
		// Not remembered; the run still uses the current choice.
	}
}
