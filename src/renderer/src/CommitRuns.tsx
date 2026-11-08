import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiRun, Finding, Review, ReviewerChoice } from '../../shared/types.ts'
import { findingRoots, findingState, LEVEL_META, SEVERITY_ORDER } from '../../shared/findings.ts'
import { AiOrb } from './AiOrb.tsx'

/**
 * The AI runs on a review's commits (one commit at a time, from the walkthrough), by commit SHA. They are kept apart
 * from the review's own runs, and arrive through the same run updates with `commitOf` set.
 */
export function useCommitRuns(reviewId: string | null) {
	const [runs, setRuns] = useState<Record<string, Array<AiRun>>>({})
	const [errors, setErrors] = useState<Record<string, { message: string; overBudget: boolean }>>({})
	const [loaded, setLoaded] = useState<string | null>(null) // the review whose stored runs have been read
	const idRef = useRef(reviewId)
	idRef.current = reviewId
	useEffect(() => {
		setRuns({})
		setErrors({})
		if (!reviewId) return
		void window.review.commitRuns(reviewId).then((r) => {
			if (idRef.current !== reviewId) return
			if (r.ok) setRuns(r.value)
			setLoaded(reviewId)
		})
	}, [reviewId])
	useEffect(
		() =>
			window.review.onAiRunUpdate((run) => {
				const of = run.commitOf
				if (!of || of.reviewId !== idRef.current) return
				setRuns((all) => {
					const list = all[of.sha] ?? []
					const i = list.findIndex((x) => x.id === run.id)
					return { ...all, [of.sha]: i < 0 ? [...list, run] : list.map((x) => (x.id === run.id ? run : x)) }
				})
			}),
		[],
	)
	const start = useCallback(async (sha: string, reviewer: ReviewerChoice, overBudget = false): Promise<void> => {
		const id = idRef.current
		if (!id) return
		setErrors(({ [sha]: _, ...rest }) => rest)
		const r = await window.review.startCommitReview(id, sha, reviewer, overBudget)
		if (idRef.current !== id) return
		if (r.ok) setRuns((all) => ({ ...all, [sha]: [...(all[sha] ?? []).filter((x) => x.id !== r.value.id), r.value] }))
		else setErrors((e) => ({ ...e, [sha]: { message: r.error.message, overBudget: r.error.code === 'over-budget' } }))
	}, [])
	const all = useMemo(() => Object.values(runs).flat(), [runs])
	return {
		runs,
		all,
		loaded: loaded !== null && loaded === reviewId,
		errors,
		start,
		latest: (sha: string): AiRun | null => runs[sha]?.at(-1) ?? null,
		running: (sha: string): boolean => runs[sha]?.some((x) => x.status === 'running') ?? false,
	}
}

export type CommitRuns = ReturnType<typeof useCommitRuns>

/** "changed in a later commit", for findings whose lines a later commit changes; null when they survive. */
export type LaterChange = (f: Finding) => string | null

/** The AI's review of one commit: its status, and its findings to open, add as comments or dismiss. */
export function CommitFindings({
	sha,
	runs,
	review,
	reviewer,
	disabled,
	selected,
	laterChange,
	onSelect,
	onAdd,
	onDismiss,
	onRestore,
}: {
	sha: string
	runs: CommitRuns
	review: Review
	reviewer: ReviewerChoice | null
	disabled: string | null
	selected: string | null
	laterChange: LaterChange
	onSelect(f: Finding): void
	onAdd(f: Finding): void
	onDismiss(f: Finding): void
	onRestore(f: Finding): void
}) {
	const run = runs.latest(sha)
	const error = runs.errors[sha]
	const roots = useMemo(() => findingRoots(runs.all), [runs.all])
	const byId = useMemo(() => new Map(runs.all.flatMap((r) => r.findings.map((f) => [f.id, f] as const))), [runs.all])
	const findings = useMemo(
		() => [...(run?.findings ?? [])].filter((f) => !f.mergedInto).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
		[run],
	)
	const start = (overBudget = false): void => {
		if (reviewer) void runs.start(sha, reviewer, overBudget)
	}
	return (
		<div className="commit-ai">
			<div className="commit-check-head">
				{run?.status === 'running' ? (
					<>
						<AiOrb activity="reasoning" size={14} label="AI review running" />
						<span className="small">Reviewing this commit…</span>
						<button className="btn small ghost" onClick={() => void window.review.cancelAiReview(run.id)}>
							Stop
						</button>
					</>
				) : run ? (
					<span className="small">
						<strong>AI review:</strong>{' '}
						{run.status === 'failed'
							? `failed${run.errors[0] ? `: ${run.errors[0]}` : ''}`
							: run.status === 'cancelled'
								? 'stopped'
								: findings.length
									? `${findings.length} finding${findings.length === 1 ? '' : 's'}`
									: 'no findings'}
						<span className="muted"> · {run.model}</span>
					</span>
				) : (
					<span className="muted small">Not reviewed by the AI.</span>
				)}
				{run?.status !== 'running' && (
					<button
						className="btn small"
						disabled={!!disabled || !reviewer}
						title={disabled ?? (reviewer ? 'Review only this commit’s changes with the AI' : 'Choose a model for AI reviews first')}
						onClick={() => start()}
					>
						{run ? 'Review again' : 'Review this commit'}
					</button>
				)}
			</div>
			{error && (
				<div className="small error-text">
					{error.message}{' '}
					{error.overBudget && (
						<button className="link" onClick={() => start(true)}>
							Review anyway
						</button>
					)}
				</div>
			)}
			{findings.length > 0 && (
				<ul className="commit-findings">
					{findings.map((f) => {
						const state = findingState(review, roots, f, byId)
						const later = laterChange(f)
						const where = f.anchor.startLine
							? `${f.anchor.newPath ?? f.anchor.oldPath}:${f.anchor.startLine}`
							: (f.anchor.newPath ?? f.anchor.oldPath)
						return (
							<li key={f.id} className={`${selected === f.id ? 'on' : ''} ${state}`}>
								<button className="commit-finding" onClick={() => onSelect(f)} title={f.body}>
									<span className={`sev ${f.severity}`}>{LEVEL_META[f.severity].label}</span>
									<span className="ellipsis">{f.title}</span>
									<span className="muted mono small nowrap">{where}</span>
								</button>
								<span className="commit-finding-actions small">
									{later && (
										<span className="pill warn" title={later}>
											Changed in a later commit
										</span>
									)}
									{state === 'accepted' ? (
										<span className="muted">Added</span>
									) : state === 'dismissed' ? (
										<button className="link" onClick={() => onRestore(f)}>
											Restore
										</button>
									) : (
										<>
											<button className="link" onClick={() => onAdd(f)}>
												Add as comment
											</button>
											<button className="link muted" onClick={() => onDismiss(f)}>
												Dismiss
											</button>
										</>
									)}
								</span>
								{selected === f.id && <p className="small selectable commit-finding-body">{f.body}</p>}
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}
