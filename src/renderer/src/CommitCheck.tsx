import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitCheck, CommitCheckEstimate, CommitCheckNote, CommitEntry } from '../../shared/types.ts'
import { AiOrb } from './AiOrb.tsx'

export const VERDICT_LABEL: Record<CommitCheck['verdict'], string> = {
	matches: 'Matches its message',
	partly: 'Partly matches',
	differs: 'Differs from its message',
}
const KIND_LABEL: Record<CommitCheckNote['kind'], string> = {
	missing: 'Said, not done',
	unmentioned: 'Done, not said',
	other: 'Note',
}

type AllState =
	| { state: 'idle' }
	| { state: 'estimating' }
	| { state: 'confirm'; shas: Array<string>; estimate: CommitCheckEstimate }
	| { state: 'running'; shas: Array<string>; done: number; overBudget: boolean }

/**
 * The AI's checks of the review's commits against their messages, kept on the review by the main process; one at a
 * time from a commit's view, or all unchecked ones after you have seen what that would cost.
 */
export function useCommitChecks(reviewId: string | null, stored: Record<string, CommitCheck> | undefined, commits: Array<CommitEntry>) {
	const [checks, setChecks] = useState<Record<string, CommitCheck>>({})
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
	const [errors, setErrors] = useState<Record<string, { message: string; overBudget: boolean }>>({})
	const [all, setAll] = useState<AllState>({ state: 'idle' })
	const [allError, setAllError] = useState<string | null>(null)
	const stop = useRef(false)
	const gen = useRef(0)
	useEffect(() => {
		gen.current++
		stop.current = true
		setChecks(stored ?? {})
		setBusy(new Set())
		setErrors({})
		setAll({ state: 'idle' })
		setAllError(null)
	}, [reviewId]) // eslint-disable-line react-hooks/exhaustive-deps

	/** Checks one commit; false when it failed (the reason is kept by commit). */
	const check = useCallback(
		async (sha: string, overBudget = false): Promise<boolean> => {
			if (!reviewId) return false
			const g = gen.current
			setBusy((b) => new Set(b).add(sha))
			setErrors(({ [sha]: _, ...rest }) => rest)
			const r = await window.review.checkCommit(reviewId, sha, overBudget)
			if (g !== gen.current) return false
			setBusy((b) => {
				const n = new Set(b)
				n.delete(sha)
				return n
			})
			if (r.ok) {
				setChecks((c) => ({ ...c, [sha]: r.value }))
				return true
			}
			setErrors((e) => ({ ...e, [sha]: { message: r.error.message, overBudget: r.error.code === 'over-budget' } }))
			return false
		},
		[reviewId],
	)

	const unchecked = commits.filter((c) => !checks[c.sha]).map((c) => c.sha)
	const estimateAll = async (): Promise<void> => {
		if (!reviewId || !unchecked.length) return
		const g = gen.current
		setAllError(null)
		setAll({ state: 'estimating' })
		const r = await window.review.estimateCommitChecks(reviewId, unchecked)
		if (g !== gen.current) return
		if (!r.ok) {
			setAll({ state: 'idle' })
			setAllError(r.error.message)
			return
		}
		setAll({ state: 'confirm', shas: unchecked, estimate: r.value })
	}
	const runAll = async (shas: Array<string>, overBudget: boolean): Promise<void> => {
		const g = gen.current
		stop.current = false
		setAllError(null)
		for (let i = 0; i < shas.length; i++) {
			if (stop.current || g !== gen.current) break
			setAll({ state: 'running', shas, done: i, overBudget })
			const ok = await check(shas[i], overBudget)
			if (!ok && g === gen.current) {
				setAllError(`Stopped at commit ${shas[i].slice(0, 7)}. The rest were not checked.`)
				break
			}
		}
		if (g === gen.current) setAll({ state: 'idle' })
	}
	return {
		checks,
		busy,
		errors,
		all,
		allError,
		unchecked,
		check,
		estimateAll,
		confirmAll: () => all.state === 'confirm' && void runAll(all.shas, all.estimate.over.length > 0),
		cancelAll: () => setAll({ state: 'idle' }),
		stopAll: () => void (stop.current = true),
		dismissAllError: () => setAllError(null),
	}
}

export type CommitChecks = ReturnType<typeof useCommitChecks>

const money = (n: number): string => `$${n.toFixed(2)}`

/** "Check all commits": what it would cost, then progress, with a way to stop. */
export function CheckAll({ cc, disabled }: { cc: CommitChecks; disabled: string | null }) {
	const a = cc.all
	if (a.state === 'confirm') {
		const e = a.estimate
		return (
			<div className="commit-check-all" role="dialog" aria-label="Check all commits">
				<span>
					Check {e.requests} commit{e.requests === 1 ? '' : 's'} against {e.requests === 1 ? 'its message' : 'their messages'}:{' '}
					{e.cost
						? `${e.cost.high < 0.01 ? 'less than $0.01' : `about ${money(e.cost.low)}–${money(e.cost.high)}`}${e.cost.estimated ? ' (catalog price)' : ''}.`
						: e.subscription
							? 'counts against your plan’s usage limits.'
							: 'the model has no price, so the cost is unknown.'}{' '}
					One request each, about {Math.round(e.inputTokens.high / Math.max(1, e.requests)).toLocaleString()} input tokens or fewer per
					commit.
				</span>
				{e.over.length > 0 && <span className="error-text">{e.over.join(' ')}</span>}
				<span className="spacer" />
				<button className="btn small primary" onClick={cc.confirmAll}>
					{e.over.length ? 'Check anyway' : 'Check'}
				</button>
				<button className="btn small ghost" onClick={cc.cancelAll}>
					Cancel
				</button>
			</div>
		)
	}
	if (a.state === 'running')
		return (
			<div className="commit-check-all" role="status">
				<AiOrb activity="reasoning" size={14} />
				<span>
					Checking commit {a.done + 1} of {a.shas.length}…
				</span>
				<span className="spacer" />
				<button className="btn small" onClick={cc.stopAll}>
					Stop after this one
				</button>
			</div>
		)
	return (
		<>
			<button
				className="btn small"
				disabled={!!disabled || a.state === 'estimating' || !cc.unchecked.length}
				onClick={() => void cc.estimateAll()}
				title={
					disabled ??
					(cc.unchecked.length
						? 'Ask the AI whether each commit not checked yet does what its message says. Shows the cost first.'
						: 'Every commit is checked.')
				}
			>
				{a.state === 'estimating' ? 'Estimating…' : `Check all commits${cc.unchecked.length ? ` (${cc.unchecked.length})` : ''}`}
			</button>
			{cc.allError && (
				<button className="link small error-text" onClick={cc.dismissAllError} title="Dismiss">
					{cc.allError} ✕
				</button>
			)}
		</>
	)
}

/** One commit's check, or the button to run it. Notes that name a file and line can become comments. */
export function CommitCheckPanel({
	sha,
	cc,
	disabled,
	onOpenFile,
	onComment,
}: {
	sha: string
	cc: CommitChecks
	disabled: string | null
	onOpenFile(path: string): void
	onComment(note: CommitCheckNote): void
}) {
	const check = cc.checks[sha]
	const busy = cc.busy.has(sha)
	const error = cc.errors[sha]
	const running = cc.all.state === 'running'
	return (
		<div className="commit-check">
			<div className="commit-check-head">
				{check ? (
					<span className={`pill verdict-${check.verdict}`} title={`Checked by ${check.model}, ${new Date(check.at).toLocaleString()}`}>
						{VERDICT_LABEL[check.verdict]}
					</span>
				) : (
					<span className="muted small">Not checked against its message.</span>
				)}
				<button
					className="btn small"
					disabled={!!disabled || busy || running}
					onClick={() => void cc.check(sha)}
					title={disabled ?? 'Ask the AI whether this commit’s diff does what its message says, and nothing else of note.'}
				>
					{busy ? (
						<>
							<AiOrb activity="reasoning" size={12} /> Checking…
						</>
					) : check ? (
						'Check again'
					) : (
						'Check against message'
					)}
				</button>
				<span className="spacer" />
				<CheckAll cc={cc} disabled={disabled} />
			</div>
			{error && (
				<div className="small error-text">
					{error.message}{' '}
					{error.overBudget && (
						<button className="link" onClick={() => void cc.check(sha, true)}>
							Check anyway
						</button>
					)}
				</div>
			)}
			{check && (
				<>
					<p className="small commit-check-summary selectable">{check.summary}</p>
					{check.notes.length > 0 && (
						<ul className="commit-check-notes small">
							{check.notes.map((n, i) => (
								<li key={i}>
									<span className={`commit-check-kind kind-${n.kind}`}>{KIND_LABEL[n.kind]}</span>{' '}
									<span className="selectable">{n.text}</span>
									{n.path && (
										<>
											{' '}
											<button className="link mono" onClick={() => onOpenFile(n.path!)}>
												{n.path}
												{n.line ? `:${n.line}` : ''}
											</button>{' '}
											<button
												className="link"
												onClick={() => onComment(n)}
												title="Start a comment with this note, at that line in the latest commit (or on the file, when the line changed later)"
											>
												Comment
											</button>
										</>
									)}
								</li>
							))}
						</ul>
					)}
					{check.omitted.length > 0 && <div className="muted small">Not read (too large or unreadable): {check.omitted.join(', ')}</div>}
				</>
			)}
		</div>
	)
}
