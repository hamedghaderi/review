import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError, PublishOutcome, PublishPlan, ReviewEvent } from '../../shared/types.ts'
import type { BlockingSummary } from '../../shared/findings.ts'
import { EmojiPicker } from './EmojiPicker.tsx'
import { GifPicker, useGifCommand } from './GifPicker.tsx'
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
export function PublishDialog({ repoId, reviewId, writeTokenUrl, onClose, onOpenGitHubSettings, beforePublish, blocking }: Props) {
	const [plan, setPlan] = useState<PublishPlan | null>(null)
	const [error, setError] = useState<AppError | null>(null)
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [outside, setOutside] = useState<'file' | 'skip'>('file')
	const [results, setResults] = useState<Map<string, PublishOutcome>>(new Map())
	const [running, setRunning] = useState<string | null>(null)
	// Blocking findings you added to the review are changes you are asking for, so that is the suggestion.
	const [event, setEvent] = useState<ReviewEvent>(blocking?.added ? 'REQUEST_CHANGES' : 'COMMENT')
	const [summary, setSummaryState] = useState(() => unsentSummaries.get(reviewId) ?? '')
	// Kept while the dialog is closed (e.g. to add a GIPHY key in Settings), until the review is submitted.
	const setSummary = (text: string): void => {
		if (text) unsentSummaries.set(reviewId, text)
		else unsentSummaries.delete(reviewId)
		setSummaryState(text)
	}
	const [confirmSubmit, setConfirmSubmit] = useState(false)
	const [showSent, setShowSent] = useState(false)
	const [checkedAt, setCheckedAt] = useState<string | null>(null)
	const [submitted, setSubmitted] = useState<string | null>(null)
	const dialog = useRef<HTMLDivElement>(null)
	const summaryRef = useRef<HTMLTextAreaElement>(null)

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

	const load = useCallback(
		async (keepSelection: boolean) => {
			setError(null)
			const r = await window.review.publishPlan(repoId, reviewId)
			if (!r.ok) return setError(r.error)
			setPlan(r.value)
			setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
			if (!keepSelection) setSelected(new Set(r.value.items.filter((i) => i.status !== 'published').map((i) => i.commentId)))
		},
		[repoId, reviewId],
	)

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
		await beforePublish()
		const next = new Map(results)
		for (const item of toPublish) {
			setRunning(`Adding ${item.label}…`)
			const r = await window.review.publishComment(repoId, reviewId, item.commentId, outside)
			next.set(item.commentId, r.ok ? r.value : { commentId: item.commentId, status: 'failed', message: r.error.message, url: null })
			setResults(new Map(next))
			// Stop on errors that will fail every remaining comment the same way.
			if (!r.ok && ['github-auth', 'github-forbidden', 'github-rate-limited', 'offline'].includes(r.error.code)) {
				setError(r.error)
				break
			}
		}
		setRunning(null)
		await load(true)
		setSelected(new Set())
	}

	async function submit(): Promise<void> {
		setRunning('Submitting review…')
		const r = await window.review.submitReview(repoId, reviewId, event, summary)
		setRunning(null)
		setConfirmSubmit(false)
		if (!r.ok) return setError(r.error)
		setSubmitted(r.value.url)
		setSummary('')
		await load(true)
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
										Enter it under GitHub settings
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
								{submitted && (
									<p className="small ok-text">
										Submitted.{' '}
										<a href={submitted} target="_blank" rel="noreferrer">
											View on GitHub ↗
										</a>
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
															blocking.openHolds ? `${blocking.openHolds} hold${blocking.openHolds === 1 ? 's' : ''}` : null,
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
										placeholder={`Summary${event === 'APPROVE' ? ' (optional)' : ''} · type /gif and a word for a GIF`}
										value={summary}
										onChange={(e) => setSummary(e.target.value)}
										onKeyDown={(e) => void gifCommand.onKeyDown(e)}
										rows={4}
										disabled={!!running}
									/>
									{gifCommand.panel}
									<div className="summary-tools">
										<EmojiPicker disabled={!!running} onPick={insertText} />
										<GifPicker disabled={!!running} onPick={pickGif} onOpenSettings={onOpenGitHubSettings} />
									</div>
								</div>
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
									{EVENTS.find((e) => e[0] === event)![1]}
								</button>
							</>
						) : (
							<>
								<button
									className={`btn ${addFirst ? '' : 'primary'}`}
									disabled={!canSubmit}
									onClick={() => setConfirmSubmit(true)}
									title={
										plan.pending.kind === 'none' && event !== 'APPROVE' && !summary.trim()
											? 'Write a summary, or add comments first'
											: 'Submit your pending review'
									}
								>
									Submit review…
								</button>
								{addFirst && (
									<button className="btn primary" disabled={!!running || !!plan.blocked} onClick={() => void publish()}>
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
