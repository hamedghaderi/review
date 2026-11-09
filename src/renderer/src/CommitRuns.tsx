import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiRun, Finding, ReviewerChoice } from '../../shared/types.ts'
import { LEVEL_META, SEVERITY_ORDER } from '../../shared/findings.ts'
import { AiOrb } from './AiOrb.tsx'

/**
 * The AI runs on a review's commits (one commit at a time, from the walkthrough), by commit SHA. They are kept apart
 * from the review's own runs, and arrive through the same run updates with `commitOf` set.
 */
export function useCommitRuns(reviewId: string | null, target: string | null) {
	const [runs, setRuns] = useState<Record<string, Array<AiRun>>>({})
	const [errors, setErrors] = useState<Record<string, { message: string; overBudget: boolean }>>({})
	const [skipped, setSkipped] = useState<Record<string, string>>({}) // commits not reviewed: why
	const [loaded, setLoaded] = useState<string | null>(null) // the review whose stored runs have been read
	const idRef = useRef(reviewId)
	idRef.current = reviewId
	const targetRef = useRef(target) // the pull request or branch: its commits' reviews are shared by every snapshot
	targetRef.current = target
	useEffect(() => {
		setRuns({})
		setErrors({})
		setSkipped({})
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
				if (!of || of.target !== targetRef.current) return
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
		if (!r.ok) return setErrors((e) => ({ ...e, [sha]: { message: r.error.message, overBudget: r.error.code === 'over-budget' } }))
		const v = r.value
		if ('skipped' in v) return setSkipped((x) => ({ ...x, [sha]: v.skipped }))
		// Its updates may have arrived first; those are newer than this reply.
		setRuns((all) => (all[sha]?.some((x) => x.id === v.id) ? all : { ...all, [sha]: [...(all[sha] ?? []), v] }))
	}, [])
	const all = useMemo(() => Object.values(runs).flat(), [runs])
	return {
		runs,
		all,
		loaded: loaded !== null && loaded === reviewId,
		errors,
		skipped,
		start,
		latest: (sha: string): AiRun | null => runs[sha]?.at(-1) ?? null,
		running: (sha: string): boolean => runs[sha]?.some((x) => x.status === 'running') ?? false,
	}
}

export type CommitRuns = ReturnType<typeof useCommitRuns>

/**
 * The AI's notes on one commit, while you walk through the commits. They are not findings yet: after the last commit
 * they are checked against the final code, and only those that still hold become the review's findings. Clicking one
 * shows its lines.
 */
export function CommitNotes({
	sha,
	runs,
	selected,
	onSelect,
}: {
	sha: string
	runs: CommitRuns
	selected: string | null
	onSelect(f: Finding): void
}) {
	const run = runs.latest(sha)
	const error = runs.errors[sha]
	const notes = useMemo(
		() => [...(run?.findings ?? [])].filter((f) => !f.mergedInto).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
		[run],
	)
	const skipped = runs.skipped[sha]
	return (
		<div className="commit-ai">
			<div className="commit-check-head">
				{skipped ? (
					<span className="small">
						<strong>AI:</strong> <span className="muted">skipped. {skipped}</span>
					</span>
				) : run?.status === 'running' ? (
					<>
						<AiOrb activity="reasoning" size={14} label="AI review running" />
						<span className="small">The AI is reviewing this commit…</span>
						<button className="btn small ghost" onClick={() => void window.review.cancelAiReview(run.id)}>
							Stop
						</button>
					</>
				) : run ? (
					<span className="small">
						<strong>AI notes:</strong>{' '}
						{run.status === 'failed'
							? `the review failed${run.errors[0] ? `: ${run.errors[0]}` : ''}`
							: run.status === 'cancelled'
								? 'stopped'
								: notes.length
									? `${notes.length}. They become findings after the last commit, if they still hold in the final code.`
									: 'nothing in this commit.'}
						<span className="muted"> · {run.model}</span>
					</span>
				) : (
					<span className="muted small">Checking whether this commit’s changes are still in the final code…</span>
				)}
			</div>
			{error && <div className="small error-text">The AI could not review this commit: {error.message}</div>}
			{notes.length > 0 && (
				<ul className="commit-findings">
					{notes.map((f) => {
						const where = f.anchor.startLine
							? `${f.anchor.newPath ?? f.anchor.oldPath}:${f.anchor.startLine}`
							: (f.anchor.newPath ?? f.anchor.oldPath)
						return (
							<li key={f.id} className={selected === f.id ? 'on' : ''}>
								<button className="commit-finding" onClick={() => onSelect(f)} title={f.body}>
									<span className={`sev ${f.severity}`}>{LEVEL_META[f.severity].label}</span>
									<span className="ellipsis">{f.title}</span>
									<span className="muted mono small nowrap">{where}</span>
								</button>
								{selected === f.id && <p className="small selectable commit-finding-body">{f.body}</p>}
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}

/**
 * Run AI review › Commit by commit asks this before it starts: the commits it will go through, from the first one after
 * your last review when there is one, and the choice to review all the changes at once instead.
 */
export function CommitReviewAsk({
	commits,
	pr,
	since,
	onStart,
	onAllChanges,
	onCancel,
}: {
	commits: Array<{ sha: string; subject: string }>
	pr: boolean
	since: { sha: string; label: string; index: number } | null // the commit you last reviewed, and its place in `commits`
	onStart(from: number): void // the index of the commit to start with
	onAllChanges(): void
	onCancel(): void
}) {
	const start = useRef<HTMLButtonElement>(null)
	useEffect(() => start.current?.focus(), [])
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') onCancel()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onCancel])
	const from = since ? since.index + 1 : 0
	const fresh = commits.length - from // commits after your last review (all of them without one)
	const sha = since?.sha.slice(0, 7)
	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
			<div className="modal commit-ask" role="dialog" aria-modal="true" aria-labelledby="commit-ask-title">
				<div className="modal-head">
					<h2 id="commit-ask-title">Review {pr ? 'this pull request' : 'this branch'} commit by commit?</h2>
				</div>
				<div className="commit-ask-body">
					<p>
						{!since
							? `The AI reviews the ${commits.length} commits one at a time, oldest first, starting with commit 1.`
							: fresh > 0
								? `${fresh} new commit${fresh === 1 ? '' : 's'} since ${since.label} (${sha}). The AI starts with commit ${from + 1} and reviews them one at a time.`
								: `No new commits since ${since.label} (${sha}). You can still go through all ${commits.length} commits.`}{' '}
						You read what it notes in each commit, then continue, and it reviews the next one. After the last commit it checks every note
						against the final code: notes later commits fixed are dropped, and the ones that still hold become the review’s findings.
					</p>
					<ol className="small commit-ask-list">
						{commits.map((c, i) => (
							<li key={c.sha} className={i < from ? 'muted' : ''}>
								<span className="mono muted">{c.sha.slice(0, 7)}</span> {c.subject}
								{since && i >= from && <span className="pill small-pill">new</span>}
							</li>
						))}
					</ol>
					<p className="muted small">
						Each commit is reviewed on its own changes, with its message. A commit the AI already reviewed in this{' '}
						{pr ? 'pull request' : 'branch'} keeps that review and is not sent again. A file changed in several commits is reviewed each
						time, so this can cost more than reviewing all the changes at once. Merge commits are left out.
					</p>
				</div>
				<div className="commit-ask-actions">
					<button className="btn small ghost" onClick={onCancel}>
						Cancel
					</button>
					<span className="spacer" />
					<button className="btn small" onClick={onAllChanges}>
						Review all changes at once
					</button>
					{since && fresh > 0 && (
						<button className="btn small" onClick={() => onStart(0)}>
							All {commits.length} commits
						</button>
					)}
					<button ref={start} className="btn small primary" onClick={() => onStart(fresh > 0 ? from : 0)}>
						{fresh > 0 && since ? `Start with commit ${from + 1}` : since ? `Go through all ${commits.length}` : 'Start with commit 1'}
					</button>
				</div>
			</div>
		</div>
	)
}
