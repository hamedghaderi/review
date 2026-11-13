import { useCallback, useEffect, useRef, useState } from 'react'
import { describeLeaks, findLeaks, maskLeaks } from '../../shared/leaks.ts'
import type { AppError, CitationCheck, PreparedReview, PublishOutcome, PublishPlan, ReviewEvent } from '../../shared/types.ts'
import type { BlockingSummary } from '../../shared/findings.ts'
import { baseLabel, type HeadChecks } from '../../shared/ci.ts'

const oldCount = (ci: HeadChecks): number => ci.failed.filter((f) => f.atBase === 'fails').length
import { ago } from './branches.ts'
import { AiOrb } from './AiOrb.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { GifPicker, useGifCommand } from './GifPicker.tsx'
import { useMentionCommand } from './Mention.tsx'
import { insertGif } from '../../shared/gif.ts'
import { plainPreview } from './reviewOps.ts'

interface Props {
	repoId: string
	reviewId: string
	writeTokenUrl: string
	onClose(): void
	onOpenGitHubSettings(): void
	beforePublish(): Promise<void> // saves pending local edits first
	blocking: BlockingSummary | null // where the AI review's blocking findings stand; null without AI findings
	onPending(pending: PendingReview | null): void // what GitHub said about your pending review, each time it is read
	canDraft: boolean // a model for questions is chosen, so the summary can be drafted with AI
	stillReviewing?: Array<string> // roles of team members the run didn't wait for that are still reviewing
	onMaskComment?(commentId: string): Promise<void> // masks what looks private in a comment (see maskLeaks) and saves it
	prepared?: PreparedReview | null // an automatic review left for you: its verdict and summary start the dialog
	onSubmitted?(): void
}

/** Your pending review on GitHub: its comments are visible only to you until it is submitted. */
export interface PendingReview {
	reviewId: string
	comments: number
	url: string
}

/** Summaries typed but not submitted yet, by review, for this app session. */
const unsentSummaries = new Map<string, string>()

const EVENTS: Array<[ReviewEvent, string, string]> = [
	['COMMENT', 'Comment', 'General feedback without explicit approval.'],
	['APPROVE', 'Approve', 'Approve these changes.'],
	['REQUEST_CHANGES', 'Request changes', 'Feedback that must be addressed before merging.'],
]

/**
 * Publishes the snapshot's comments into the viewer's pending GitHub review (visible only to them), then optionally
 * submits it. Each step is an explicit action; the plan is re-read from GitHub before and after.
 */
export function PublishDialog({
	repoId,
	reviewId,
	writeTokenUrl,
	onClose,
	onOpenGitHubSettings,
	beforePublish,
	blocking,
	onPending,
	canDraft,
	stillReviewing,
	onMaskComment,
	prepared,
	onSubmitted,
}: Props) {
	const [plan, setPlan] = useState<PublishPlan | null>(null)
	const [error, setError] = useState<AppError | null>(null)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [outside, setOutside] = useState<'file' | 'skip'>('file')
	const [results, setResults] = useState<Map<string, PublishOutcome>>(new Map())
	const [running, setRunning] = useState<string | null>(null)
	const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null) // while adding comments
	// Blocking findings you added to the review are changes you are asking for, so that is the suggestion.
	// A prepared automatic review starts with its verdict and summary (an approval is re-checked: see headMoved).
	const [event, setEvent] = useState<ReviewEvent>(prepared?.event ?? (blocking?.added ? 'REQUEST_CHANGES' : 'COMMENT'))
	const [summary, setSummaryState] = useState(() => unsentSummaries.get(reviewId) ?? prepared?.body ?? '')
	// Kept while the dialog is closed (e.g. to add a GIPHY key in Settings), until the review is submitted.
	const setSummary = (text: string): void => {
		if (text) unsentSummaries.set(reviewId, text)
		else unsentSummaries.delete(reviewId)
		setSummaryState(text)
	}
	const [drafting, setDrafting] = useState(false)
	const [drafted, setDrafted] = useState(false) // the summary holds an AI draft you have not cleared
	const [draftError, setDraftError] = useState<string | null>(null)
	const [rewriting, setRewriting] = useState(false)
	// The last rewrite (issue #191): what it replaced, for undo, and what it found about the references in your text.
	const [rewrite, setRewrite] = useState<{
		before: string
		after: string
		wasDrafted: boolean
		checks: Array<CitationCheck>
		dropped: Array<string>
	} | null>(null)
	const [confirmSubmit, setConfirmSubmit] = useState(false)
	const [showSent, setShowSent] = useState(false)
	const [checkedAt, setCheckedAt] = useState<string | null>(null)
	const [submitted, setSubmitted] = useState<string | null>(null)
	const [ci, setCi] = useState<HeadChecks | null>(null)
	const [ciError, setCiError] = useState<string | null>(null)
	const dialog = useRef<HTMLDivElement>(null)
	const summaryRef = useRef<HTMLTextAreaElement>(null)

	// Your comments are saved first so the draft sees the latest. What you already typed stays; the draft goes after it.
	const draftSummary = async (): Promise<void> => {
		if (drafting) return
		setDrafting(true)
		setDraftError(null)
		try {
			await beforePublish()
			const r = await window.review.draftSummary(reviewId, event)
			if (!r.ok) return setDraftError(r.error.message)
			const typed = summaryRef.current?.value ?? summary
			setSummary(typed.trim() ? `${typed.trimEnd()}\n\n${r.value}` : r.value)
			setDrafted(true)
			requestAnimationFrame(() => summaryRef.current?.focus())
		} finally {
			setDrafting(false)
		}
	}

	// Rewrites what you selected, or all of it when nothing is: your words, tightened, with their references checked.
	const rewriteSummary = async (): Promise<void> => {
		if (rewriting || drafting) return
		const el = summaryRef.current
		const current = el?.value ?? summary
		let start = el?.selectionStart ?? 0
		let end = el?.selectionEnd ?? 0
		const partial = end > start && !!current.slice(start, end).trim() && (start > 0 || end < current.length)
		if (!partial) {
			start = 0
			end = current.length
		}
		const picked = current.slice(start, end)
		if (!picked.trim()) return
		setRewriting(true)
		setDraftError(null)
		try {
			const r = await window.review.rewriteSummary(reviewId, event, picked, partial)
			if (!r.ok) return setDraftError(r.error.message)
			// The selection's own leading and trailing blank space stays, so paragraphs around it keep their spacing.
			const lead = /^\s*/.exec(picked)![0]
			const trail = /\s*$/.exec(picked)![0]
			const inserted = `${lead}${r.value.text}${trail}`
			const after = current.slice(0, start) + inserted + current.slice(end)
			setRewrite({ before: current, after, wasDrafted: drafted, checks: r.value.checks, dropped: r.value.dropped })
			setSummary(after)
			setDrafted(true)
			placeCursor(start + inserted.length)
		} finally {
			setRewriting(false)
		}
	}
	const undoRewrite = (): void => {
		if (!rewrite) return
		setSummary(rewrite.before)
		setDrafted(rewrite.wasDrafted)
		setRewrite(null)
		placeCursor(rewrite.before.length)
	}

	// Inserts at the cursor (replacing a selection), then puts the cursor after the inserted text.
	const insertText = (text: string): void => {
		const el = summaryRef.current
		const start = el?.selectionStart ?? summary.length
		const end = el?.selectionEnd ?? summary.length
		setSummary(summary.slice(0, start) + text + summary.slice(end))
		requestAnimationFrame(() => {
			el?.focus()
			el?.setSelectionRange(start + text.length, start + text.length)
		})
	}
	const placeCursor = (cursor: number): void => {
		requestAnimationFrame(() => {
			summaryRef.current?.focus()
			summaryRef.current?.setSelectionRange(cursor, cursor)
		})
	}
	// A GIF goes on a line of its own, so GitHub shows it as an image block.
	const pickGif = (markdown: string): void => {
		const el = summaryRef.current
		const r = insertGif(summary, el?.selectionStart ?? summary.length, el?.selectionEnd ?? summary.length, markdown)
		setSummary(r.text)
		placeCursor(r.cursor)
	}
	const gifCommand = useGifCommand(summary, summaryRef, (next) => setSummary(next), onOpenGitHubSettings, 'above')
	const mention = useMentionCommand(summary, summaryRef, (next) => setSummary(next), 'above')

	const load = useCallback(
		async (keepSelection: boolean) => {
			setError(null)
			const r = await window.review.publishPlan(repoId, reviewId)
			if (!r.ok) return setError(r.error)
			setPlan(r.value)
			const p = r.value.pending
			onPending(p.kind === 'none' ? null : { reviewId, comments: p.comments, url: p.url })
			setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
			if (!keepSelection) setSelected(new Set(r.value.items.filter((i) => i.status !== 'published').map((i) => i.commentId)))
		},
		[repoId, reviewId], // eslint-disable-line react-hooks/exhaustive-deps
	)

	// CI for the snapshot's head commit, read again before an approval is confirmed: checks often fail after the review.
	const loadCi = useCallback(async (): Promise<HeadChecks | null> => {
		const r = await window.review.headChecks(repoId, reviewId)
		if (!r.ok) {
			setCiError(r.error.message)
			return null
		}
		setCi(r.value)
		setCiError(null)
		return r.value
	}, [repoId, reviewId])

	useEffect(() => {
		void loadCi()
	}, [loadCi])

	async function askToSubmit(): Promise<void> {
		if (event === 'APPROVE') {
			setRunning('Checking CI…')
			await loadCi()
			setRunning(null)
		}
		setConfirmSubmit(true)
	}

	useEffect(() => {
		dialog.current?.focus()
		void beforePublish().then(() => load(false))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape' && !running) onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose, running])

	const toPublish = plan?.items.filter((i) => selected.has(i.commentId) && i.status !== 'published') ?? []

	async function publish(): Promise<void> {
		const items = toPublish
		setRunning('Adding comments…')
		setProgress({ done: 0, total: items.length, current: items[0]?.label ?? '' })
		await beforePublish()
		const next = new Map(results)
		for (const [n, item] of items.entries()) {
			setProgress({ done: n, total: items.length, current: item.label })
			const r = await window.review.publishComment(repoId, reviewId, item.commentId, outside)
			next.set(item.commentId, r.ok ? r.value : { commentId: item.commentId, status: 'failed', message: r.error.message, url: null })
			setResults(new Map(next))
			// Stop on errors that will fail every remaining comment the same way.
			if (!r.ok && ['github-auth', 'github-forbidden', 'github-rate-limited', 'offline'].includes(r.error.code)) {
				setError(r.error)
				break
			}
		}
		setProgress(null)
		setRunning('Checking GitHub…')
		await load(true)
		setRunning(null)
		setSelected(new Set())
	}

	async function submit(): Promise<void> {
		setRunning('Submitting review…')
		const r = await window.review.submitReview(repoId, reviewId, event, summary)
		setRunning(null)
		setConfirmSubmit(false)
		if (!r.ok) return setError(r.error)
		setSubmitted(r.value.url)
		onSubmitted?.()
		setSummary('')
		setDrafted(false)
		await load(true)
	}

	// What looks private in what is about to go out (issue #159): shown, maskable, and posted only once you say so. Keys
	// always need that; home paths and what MCP tools returned only on a public repository (or one of unknown visibility).
	const strict = plan?.pr.private !== true
	const outgoing = [
		...toPublish.map((i) => ({ id: i.commentId, label: i.label, leaks: findLeaks(i.body), mcp: i.external ?? [] })),
		{ id: '', label: 'Summary', leaks: findLeaks(summary), mcp: [] as Array<string> },
	].filter((x) => x.leaks.length || x.mcp.length)
	const gating = outgoing.filter((x) => x.leaks.some((l) => strict || l.kind === 'credential') || (strict && x.mcp.length))
	const leakKey = gating.map((x) => `${x.id}:${x.leaks.map((l) => `${l.start}-${l.end}`).join(',')}:${x.mcp.join(',')}`).join('|')
	const [checkedLeaks, setCheckedLeaks] = useState('')
	const leaksOk = !gating.length || checkedLeaks === leakKey
	const mask = async (id: string): Promise<void> => {
		if (!id) return setSummary(maskLeaks(summary))
		if (!onMaskComment) return
		setRunning('Masking…')
		await onMaskComment(id)
		await load(true)
		setRunning(null)
	}

	const pendingOurs = plan?.pending.kind !== 'none' && plan?.pending.usable
	const permission =
		error?.code === 'github-forbidden' ||
		error?.code === 'github-auth' ||
		plan?.blocked?.code === 'github-forbidden' ||
		plan?.blocked?.code === 'github-auth'

	const unsent = plan?.items.filter((i) => i.status !== 'published') ?? []
	const sent = plan?.items.filter((i) => i.status === 'published') ?? []
	const canSubmit = !!plan && !running && !plan.blocked && !(plan.pending.kind === 'none' && event !== 'APPROVE' && !summary.trim())
	// One main action at a time: send the selected comments first, then submit.
	const addFirst = toPublish.length > 0
	const addLabel = `${pendingOurs || plan?.pending.kind !== 'none' ? 'Add' : 'Start a pending review with'} ${toPublish.length} comment${toPublish.length === 1 ? '' : 's'}`

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
			<div className="modal publish" role="dialog" aria-modal="true" aria-labelledby="publish-title" tabIndex={-1} ref={dialog}>
				<div className="modal-head publish-head">
					<div className="publish-titles">
						<h2 id="publish-title">Publish review</h2>
						{plan && (
							<a className="small muted mono" href={plan.pr.url} target="_blank" rel="noreferrer">
								{plan.pr.repo} #{plan.pr.number} ↗
							</a>
						)}
					</div>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} disabled={!!running} aria-label="Close">
						✕
					</button>
				</div>
				<div className="settings-main form publish-body">
					{!plan && !error && <p className="muted">Checking GitHub…</p>}
					{(error || plan?.blocked) && (
						<div className="notice error-notice selectable" role="alert">
							{(error ?? plan!.blocked)!.message}
							{permission && (
								<div className="publish-actions">
									<a href={writeTokenUrl} target="_blank" rel="noreferrer">
										Create a token with “Pull requests: Read and write” ↗
									</a>
									<button className="link" onClick={onOpenGitHubSettings}>
										Enter it in Settings → GitHub
									</button>
								</div>
							)}
						</div>
					)}
					{plan && (
						<>
							<p className="small muted">
								Comments go into <strong>your pending review</strong> on GitHub. Nobody else sees them until you submit it. Your local
								comments never change.
							</p>

							<section className="publish-step" aria-labelledby="publish-step-comments">
								<div className="publish-step-head">
									<span className="step-n">1</span>
									<h3 id="publish-step-comments">Comments</h3>
									<span className="spacer" />
									{checkedAt && (
										<button
											className="btn small ghost"
											disabled={!!running}
											onClick={() => void load(true)}
											title="Read your pending review from GitHub again"
										>
											Checked {checkedAt} ↻
										</button>
									)}
								</div>
								{plan.pending.kind !== 'none' && (
									<p className="small muted">
										{plan.pending.kind === 'ours' ? 'Your pending review from this app' : 'Your pending review started on GitHub'} is on
										commit <span className="mono">{plan.pending.commit.slice(0, 7)}</span>.
										{plan.pending.usable ? ' New comments are added to it.' : ''}
									</p>
								)}
								{plan.headMoved && (
									<p className="small warn-text">
										The pull request has newer commits ({plan.pr.headSha?.slice(0, 7)}) than this snapshot ({plan.snapshotHead.slice(0, 7)}
										). Comments are attached to the snapshot’s commit; GitHub may show them as outdated where the lines changed since.
									</p>
								)}
								{progress && (
									<div className="publish-progress" role="status" aria-live="polite">
										<div className="publish-progress-line small">
											<span>
												Adding comment {Math.min(progress.done + 1, progress.total)} of {progress.total} to your pending review…
											</span>
											<span className="spacer" />
											<span className="muted">{Math.round((100 * progress.done) / progress.total)}%</span>
										</div>
										<div
											className="publish-progress-bar"
											role="progressbar"
											aria-label="Comments added"
											aria-valuemin={0}
											aria-valuemax={progress.total}
											aria-valuenow={progress.done}
										>
											<span style={{ width: `${(100 * progress.done) / progress.total}%` }} />
										</div>
										<span className="small muted mono ellipsis">{progress.current}</span>
										<span className="small muted">Keep this window open until it finishes.</span>
									</div>
								)}
								{plan.items.length === 0 && (
									<p className="muted small">This snapshot has no comments yet. You can still submit a review with a summary below.</p>
								)}
								{sent.length > 0 && (
									<div className="publish-sent">
										<button className="publish-sent-row" onClick={() => setShowSent((v) => !v)} aria-expanded={showSent}>
											<span className="ok-text" aria-hidden>
												✓
											</span>
											<span>
												{unsent.length === 0 ? 'All ' : ''}
												{sent.length} comment{sent.length === 1 ? ' is' : 's are'} on GitHub
											</span>
											<span className="spacer" />
											<span className="small muted">{showSent ? 'Hide' : 'Show'}</span>
										</button>
										{showSent && (
											<div className="publish-list">
												{sent.map((i) => (
													<div key={i.commentId} className="publish-item done">
														<ItemBody label={i.label} body={i.body} tag={null} url={i.url} />
													</div>
												))}
											</div>
										)}
									</div>
								)}
								{unsent.length > 0 && (
									<div className="publish-list" role="group" aria-label="Comments to send">
										{unsent.map((i) => {
											const res = results.get(i.commentId)
											return (
												<label key={i.commentId} className="publish-item">
													<input
														type="checkbox"
														checked={selected.has(i.commentId)}
														disabled={!!running}
														onChange={(e) => {
															const n = new Set(selected)
															if (e.target.checked) n.add(i.commentId)
															else n.delete(i.commentId)
															setSelected(n)
														}}
													/>
													<span className="publish-main">
														<ItemBody
															label={i.label}
															body={i.body}
															url={i.url}
															tag={
																i.status === 'changed'
																	? 'Edited'
																	: i.placement.kind === 'file'
																		? 'File comment'
																		: i.placement.kind === 'outside-diff'
																			? 'Outside diff'
																			: 'New'
															}
														/>
														{i.placement.kind === 'outside-diff' && (
															<span className="small warn-text">
																{i.placement.reason}{' '}
																{outside === 'file' ? 'It will be posted as a file comment that names the lines.' : 'It will be skipped.'}
															</span>
														)}
														{res && res.status !== 'published' && (
															<span className={`small ${res.status === 'failed' ? 'error-text' : 'muted'}`}>
																{res.status === 'updated' ? 'Updated on GitHub.' : res.message}
															</span>
														)}
													</span>
												</label>
											)
										})}
									</div>
								)}
								{unsent.some((i) => i.placement.kind === 'outside-diff') && (
									<fieldset className="radio-row small">
										<legend className="muted">Comments on lines GitHub doesn’t show</legend>
										<label className="radio">
											<input type="radio" checked={outside === 'file'} onChange={() => setOutside('file')} /> Post as file comments
										</label>
										<label className="radio">
											<input type="radio" checked={outside === 'skip'} onChange={() => setOutside('skip')} /> Skip them
										</label>
									</fieldset>
								)}
								{(plan.drafts > 0 || plan.removed > 0) && (
									<p className="small muted">
										{plan.drafts > 0 &&
											`${plan.drafts} unsaved draft${plan.drafts === 1 ? ' is' : 's are'} not published; submit ${plan.drafts === 1 ? 'it' : 'them'} as comments first. `}
										{plan.removed > 0 &&
											`${plan.removed} comment${plan.removed === 1 ? ' was' : 's were'} deleted here after publishing and stay on GitHub.`}
									</p>
								)}
							</section>

							<section className="publish-step" aria-labelledby="publish-step-submit">
								<div className="publish-step-head">
									<span className="step-n">2</span>
									<h3 id="publish-step-submit">Submit</h3>
								</div>
								{plan.pending.kind !== 'none' && plan.pending.usable && plan.pending.comments > 0 && !running && (
									<div className="pending-callout small" role="status">
										<strong>
											{plan.pending.comments} comment{plan.pending.comments === 1 ? ' is' : 's are'} waiting in your pending review.
										</strong>{' '}
										Only you can see {plan.pending.comments === 1 ? 'it' : 'them'} until you submit the review below.
									</div>
								)}
								{submitted && (
									<p className="small ok-text">
										Submitted.{' '}
										<a href={submitted} target="_blank" rel="noreferrer">
											View on GitHub ↗
										</a>
									</p>
								)}
								{outgoing.length > 0 && (
									<div className="leak-check small">
										<p className="warn-text">
											<b>Check before posting.</b> This may be private, and once it's on GitHub it stays there even after the code changes
											{plan.pr.private === true
												? '. The repository is private, so only keys and tokens need your OK'
												: plan.pr.private === false
													? '. The repository is public: anyone can read it'
													: ". Review couldn't tell whether the repository is public, so it's treated as public"}
											:
										</p>
										<ul>
											{outgoing.map((x) => (
												<li key={x.id || 'summary'}>
													<span className="mono">{x.label}</span>:{' '}
													{[
														x.leaks.length ? describeLeaks(x.leaks) : null,
														x.mcp.length ? `its finding read ${x.mcp.join(', ')} through MCP, so it may quote something from there` : null,
													]
														.filter(Boolean)
														.join('; ')}{' '}
													{x.leaks.length > 0 && (x.id ? !!onMaskComment : true) && (
														<button className="link" onClick={() => void mask(x.id)} disabled={!!running}>
															Mask
														</button>
													)}
												</li>
											))}
										</ul>
										{gating.length > 0 && (
											<label className="check">
												<input type="checkbox" checked={leaksOk} onChange={(e) => setCheckedLeaks(e.target.checked ? leakKey : '')} />
												<span>I checked these: post them as they are</span>
											</label>
										)}
									</div>
								)}
								{!!stillReviewing?.length && (
									<p className="small warn-text">
										{stillReviewing.join(' and ')} {stillReviewing.length === 1 ? 'is' : 'are'} still reviewing this change. Anything{' '}
										{stillReviewing.length === 1 ? 'it finds' : 'they find'} after you submit won't be part of this review.
									</p>
								)}
								{blocking && (blocking.added > 0 || blocking.open > 0) && (
									<div className="blocking-summary small">
										{blocking.added > 0 && (
											<p>
												You added {blocking.added} blocking finding{blocking.added === 1 ? '' : 's'} to this review, so{' '}
												<b>Request changes</b> is selected.
											</p>
										)}
										{blocking.open > 0 && (
											<p className="warn-text">
												{blocking.open} blocking finding{blocking.open === 1 ? ' is' : 's are'} not decided yet
												{blocking.openHolds || blocking.openWrong
													? ` (double-check: ${[
															blocking.openHolds ? `${blocking.openHolds} not disproved` : null,
															blocking.openWrong ? `${blocking.openWrong} likely wrong` : null,
														]
															.filter(Boolean)
															.join(', ')})`
													: ''}
												. Add or dismiss {blocking.open === 1 ? 'it' : 'them'} in the Findings panel first, or submit without them.
											</p>
										)}
										{event === 'APPROVE' && blocking.added > 0 && (
											<p className="warn-text">
												You are approving while your comments include {blocking.added} blocking finding{blocking.added === 1 ? '' : 's'}.
											</p>
										)}
									</div>
								)}
								<CiLine ci={ci} error={ciError} approving={event === 'APPROVE'} onRefresh={() => void loadCi()} />
								<div className="seg verdict" role="radiogroup" aria-label="Review verdict">
									{EVENTS.map(([k, label, hint]) => (
										<button
											key={k}
											role="radio"
											aria-checked={event === k}
											className={`${event === k ? 'on' : ''} ${k.toLowerCase()}`}
											title={hint}
											disabled={!!running}
											onClick={() => setEvent(k)}
										>
											{label}
										</button>
									))}
								</div>
								<div className="gif-anchor summary-box">
									<textarea
										ref={summaryRef}
										className="summary"
										placeholder={
											drafting
												? 'Drafting a summary…'
												: `Summary${event === 'APPROVE' ? ' (optional)' : ''} · type /gif and a word for a GIF`
										}
										value={summary}
										onChange={(e) => {
											setSummary(e.target.value)
											if (!e.target.value.trim()) setDrafted(false) // emptied: what you type next is yours
										}}
										onKeyDown={(e) => void (gifCommand.onKeyDown(e) || mention.onKeyDown(e))}
										rows={drafted ? 6 : 4}
										readOnly={drafting || rewriting}
										disabled={!!running}
									/>
									{gifCommand.panel}
									{mention.panel}
									{/* Formatting on the left, the AI on the right: a bar under the text, never over it. */}
									<div className="summary-tools" role="toolbar" aria-label="Summary tools">
										<EmojiPicker disabled={!!running} onPick={insertText} />
										<GifPicker disabled={!!running} onPick={pickGif} onOpenSettings={onOpenGitHubSettings} />
										<span className="spacer" />
										{rewrite && summary === rewrite.after && (
											<button className="btn small ghost" onClick={undoRewrite} disabled={rewriting || !!running}>
												Undo rewrite
											</button>
										)}
										{canDraft && summary.trim() && (
											<button
												className="btn small ai"
												onClick={() => void rewriteSummary()}
												disabled={rewriting || drafting || !!running}
												title="Your model for questions rewrites what you selected, or all of it, in fewer words and in your review style, without changing what it says. Each file:line it cites is checked against the head commit. Nothing is sent until you submit."
											>
												{rewriting ? <AiOrb activity="reasoning" size={12} /> : <AiMark />}
												{rewriting ? 'Rewriting…' : 'Rewrite with AI'}
											</button>
										)}
										{canDraft && (
											<button
												className="btn small ai"
												onClick={() => void draftSummary()}
												disabled={drafting || !!running}
												title={`Your model for questions drafts a summary for “${EVENTS.find((e) => e[0] === event)![1]}” from your comments in this review, in your review style when that is on. Nothing is sent until you submit.`}
											>
												{drafting ? <AiOrb activity="reasoning" size={12} /> : <AiMark />}
												{drafting ? 'Drafting…' : 'Draft with AI'}
											</button>
										)}
									</div>
								</div>
								{drafted && summary.trim() && <p className="muted small summary-note">Drafted by AI: check it before you submit.</p>}
								{draftError && <p className="small error-text">{draftError}</p>}
								{rewrite && <RewriteChecks checks={rewrite.checks} dropped={rewrite.dropped} />}
							</section>
						</>
					)}
				</div>
				{plan && (
					<div className={`publish-footer${confirmSubmit ? ' confirm' : ''}`}>
						{running ? (
							<span className="small muted" role="status">
								<span className="spinner small" aria-hidden /> {running}
							</span>
						) : confirmSubmit && event === 'APPROVE' && ci && (ci.failed.length > 0 || ci.pending.length > 0) ? (
							<span className="small warn-text" role="alert">
								<strong>{ciWarning(ci)}</strong> Approve anyway? Everyone on the pull request will see it, and it can’t be unsent.
							</span>
						) : confirmSubmit ? (
							<span className="small">
								Submit as <strong>{EVENTS.find((e) => e[0] === event)![1]}</strong>
								{plan.pending.kind !== 'none' ? ' with every comment in your pending review' : ''}? Everyone on the pull request will see
								it, and it can’t be unsent.
							</span>
						) : (
							<a className="small" href={`${plan.pr.url}/files`} target="_blank" rel="noreferrer">
								Finish on GitHub ↗
							</a>
						)}
						<span className="spacer" />
						{confirmSubmit ? (
							<>
								<button className="btn" onClick={() => setConfirmSubmit(false)} disabled={!!running}>
									Cancel
								</button>
								<button className={`btn primary ${event.toLowerCase()}`} onClick={() => void submit()} disabled={!!running}>
									{event === 'APPROVE' && ci && (ci.failed.length > 0 || ci.pending.length > 0)
										? 'Approve anyway'
										: EVENTS.find((e) => e[0] === event)![1]}
								</button>
							</>
						) : (
							<>
								<button
									className={`btn ${addFirst ? '' : 'primary'}`}
									disabled={!canSubmit || !leaksOk}
									onClick={() => void askToSubmit()}
									title={
										!leaksOk
											? 'Mask what looks private above, or tick that you checked it'
											: plan.pending.kind === 'none' && event !== 'APPROVE' && !summary.trim()
												? 'Write a summary, or add comments first'
												: 'Submit your pending review'
									}
								>
									Submit review…
								</button>
								{addFirst && (
									<button
										className="btn primary"
										disabled={!!running || !!plan.blocked || !leaksOk}
										onClick={() => void publish()}
										title={leaksOk ? undefined : 'Mask what looks private above, or tick that you checked it'}
									>
										{addLabel}
									</button>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

/** One comment: where it goes, a short tag, and its text as it reads (markup and tags stripped, levels as pills). */
function ItemBody({ label, body, tag, url }: { label: string; body: string; tag: string | null; url: string | null }) {
	const { pills, text } = plainPreview(body)
	return (
		<span className="publish-item-body">
			<span className="publish-line">
				<span className="mono small ellipsis">{label}</span>
				{tag && <span className="src-tag">{tag}</span>}
				{url && (
					<a className="small" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
						View ↗
					</a>
				)}
			</span>
			<span className="small publish-text">
				{pills.map((p) => (
					<span key={p} className="pill small-pill">
						{p}
					</span>
				))}
				<span className="ellipsis">{text}</span>
			</span>
		</span>
	)
}

/**
 * "1 check failed on this commit (Unit tests, 18 s ago), 1 more fails at base abc1234 too (Lint) and 3 haven’t
 * finished." Failures the base has too are listed apart, never left out.
 */
function ciWarning(ci: HeadChecks): string {
	const parts: Array<string> = []
	const fresh = ci.failed.filter((f) => f.atBase !== 'fails')
	const old = ci.failed.filter((f) => f.atBase === 'fails')
	const names = (xs: HeadChecks['failed'], when: boolean) =>
		`${xs[0].name}${when && xs[0].at ? `, ${ago(xs[0].at)}` : ''}${xs.length > 1 ? ` and ${xs.length - 1} more` : ''}`
	if (fresh.length) parts.push(`${fresh.length} check${fresh.length === 1 ? '' : 's'} failed on this commit (${names(fresh, true)})`)
	if (old.length) {
		const at = baseLabel(ci.base!)
		parts.push(
			fresh.length
				? `${old.length} more ${old.length === 1 ? 'fails' : 'fail'} at ${at} too (${names(old, false)})`
				: `${old.length} check${old.length === 1 ? '' : 's'} failed on this commit, but ${old.length === 1 ? 'it fails' : 'they fail'} at ${at} too (${names(old, false)})`,
		)
	}
	if (ci.pending.length) parts.push(`${ci.pending.length} ${ci.pending.length === 1 ? 'hasn’t' : 'haven’t'} finished`)
	return `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}.`
}

/** "✕ Lint: also fails at base abc1234" for the tooltip. */
function failedLine(f: HeadChecks['failed'][number], ci: HeadChecks): string {
	const at = ci.base
		? ` (${f.atBase === 'fails' ? 'also fails' : f.atBase === 'passes' ? 'passes' : 'no result'} at ${baseLabel(ci.base)})`
		: ''
	return `✕ ${f.name}${at}`
}

/** What CI says about the snapshot's head commit, next to the verdict. */
function CiLine({
	ci,
	error,
	approving,
	onRefresh,
}: {
	ci: HeadChecks | null
	error: string | null
	approving: boolean
	onRefresh(): void
}) {
	if (error)
		return (
			<p className="small muted">
				CI couldn’t be read: {error}{' '}
				<button className="link" onClick={onRefresh}>
					Retry
				</button>
			</p>
		)
	if (!ci) return <p className="small muted">Reading CI…</p>
	const total = ci.failed.length + ci.pending.length + ci.passed
	const warn = approving && (ci.failed.length > 0 || ci.pending.length > 0)
	return (
		<p
			className={`small ci-line ${warn ? 'warn-text' : 'muted'}`}
			title={[...ci.failed.map((f) => failedLine(f, ci)), ...ci.pending.map((n) => `◌ ${n}`)].join('\n')}
		>
			CI on <span className="mono">{ci.sha.slice(0, 7)}</span>:{' '}
			{total === 0
				? 'no checks reported'
				: [
						ci.failed.length ? `✕ ${ci.failed.length} failed${oldCount(ci) ? ` (${oldCount(ci)} also at base)` : ''}` : null,
						ci.pending.length ? `◌ ${ci.pending.length} not finished` : null,
						ci.passed ? `✓ ${ci.passed} passed` : null,
					]
						.filter(Boolean)
						.join(' · ')}
			{warn && ` — ${ciWarning(ci)}`} · read {ago(ci.readAt)}{' '}
			<button className="link" onClick={onRefresh}>
				Refresh
			</button>
		</p>
	)
}

const CHECK_LABEL: Record<CitationCheck['verdict'], string> = {
	holds: 'matches the code',
	wrong: 'not what the code shows',
	unsure: 'not settled by the code',
	unopened: 'not checked',
}

/** What the last rewrite found about each file:line your text cites; anything not confirmed is said plainly. */
function RewriteChecks({ checks, dropped }: { checks: Array<CitationCheck>; dropped: Array<string> }) {
	const opened = checks.filter((c) => c.verdict !== 'unopened').length
	return (
		<div className="rewrite-checks small" role="status">
			<p className="muted">
				{checks.length
					? `Checked ${opened} of ${checks.length} file:line reference${checks.length === 1 ? '' : 's'} against the head commit. Claims without one weren't checked.`
					: 'Your text cites no file:line, so nothing in it was checked against the code.'}
			</p>
			{(checks.length > 0 || dropped.length > 0) && (
				<ul>
					{checks.map((c) => (
						<li key={c.ref} className={`rewrite-check ${c.verdict}`}>
							<code>{c.ref}</code> {CHECK_LABEL[c.verdict]}
							{c.note && <span className="muted">: {c.note}</span>}
						</li>
					))}
					{dropped.map((ref) => (
						<li key={`dropped:${ref}`} className="rewrite-check dropped">
							The rewrite left out <code>{ref}</code>; put it back if the claim needs it.
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/** The mark on buttons that ask the AI to write something: a four-point sparkle, in the button's colour. */
function AiMark() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
			<path d="M8 0.5c.4 3.6 3.9 7.1 7.5 7.5-3.6.4-7.1 3.9-7.5 7.5C7.6 11.9 4.1 8.4.5 8 4.1 7.6 7.6 4.1 8 .5Z" />
		</svg>
	)
}
