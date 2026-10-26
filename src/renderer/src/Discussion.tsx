import { useState } from 'react'
import type {
	ChangedFile,
	Discussion,
	DiscussionComment,
	DiscussionThread,
	MyLastReview,
	RaisedBefore,
	RaisedOutcome,
} from '../../shared/types.ts'
import { ago } from './branches.ts'
import { isNewSince, matchesThread, SINCE_ORDER, sinceMine, type SinceMine, type ThreadFilter } from './discussed.ts'
import { rangeLabel } from './diffModel.ts'
import { useStored } from './useStored.ts'

const THREAD_FILTERS: ReadonlyArray<ThreadFilter> = ['all', 'since', 'open', 'resolved']

const SINCE_LABEL: Record<SinceMine, string> = { new: 'New thread', replied: 'Replied', changed: 'Code changed', waiting: 'No response' }
const SINCE_TITLE: Record<SinceMine, string> = {
	new: 'Started after your last review',
	replied: 'Someone answered after your last review',
	changed: 'Nobody answered, but its lines changed since the commit you reviewed',
	waiting: 'You wrote in it, and nothing happened since your last review',
}

/** The first comment someone else wrote after your last review; -1 when there is none. */
export function firstNew(comments: Array<DiscussionComment>, mine: MyLastReview | null | undefined): number {
	return mine ? comments.findIndex((c) => isNewSince(c, mine) && c.author !== mine.viewer) : -1
}

/** Marks where the comments you haven't seen start, inside a thread. */
export function NewSinceDivider() {
	return <div className="since-divider small">New since your review</div>
}

function reviewState(state: string): string {
	return state === 'APPROVED' ? 'approved' : state === 'CHANGES_REQUESTED' ? 'changes requested' : state.toLowerCase().replace(/_/g, ' ')
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`
}

/** Who started each thread, each a link to it on GitHub when it has one. */
function who(ts: Array<DiscussionThread>) {
	const shown = ts.slice(0, 3)
	return (
		<>
			{shown.map((t, i) => (
				<span key={t.id}>
					{i > 0 && ', '}
					<ThreadLink t={t} />
				</span>
			))}
			{ts.length > shown.length && ` and ${ts.length - shown.length} more`}
		</>
	)
}

function ThreadLink({ t }: { t: DiscussionThread }) {
	const name = t.comments[0]?.author ?? 'unknown user'
	return t.url ? (
		<a href={t.url} target="_blank" rel="noreferrer" title="Open the thread on GitHub">
			{name}
		</a>
	) : (
		<>{name}</>
	)
}

/**
 * "Already discussed on GitHub: 1 open thread (alice) · 1 resolved (bob)." Each name links to its thread. `unclaimed`:
 * on a finding, the AI didn't say it had read these threads, so the reader is told to check it isn't a repeat.
 */
export function AlreadyDiscussed({ threads, unclaimed = false }: { threads: Array<DiscussionThread>; unclaimed?: boolean }) {
	if (!threads.length) return null
	const open = threads.filter((t) => t.resolved === false)
	const resolved = threads.filter((t) => t.resolved === true)
	const unknown = threads.filter((t) => t.resolved === null)
	const parts = [
		open.length ? (
			<span key="open">
				{count(open.length, 'open thread')} ({who(open)})
			</span>
		) : null,
		resolved.length ? (
			<span key="resolved">
				{resolved.length} resolved ({who(resolved)})
			</span>
		) : null,
		unknown.length ? (
			<span key="unknown">
				{count(unknown.length, 'thread')} ({who(unknown)})
			</span>
		) : null,
	].filter(Boolean)
	return (
		<div
			className="discussed-note small"
			title="Shown so you can read the thread first. It doesn't change or hide anything, and a resolved thread doesn't mean the code changed."
		>
			<b>Already discussed on GitHub:</b> {parts.map((x, i) => [i > 0 && ' · ', x])}.
			{unclaimed && ' The AI didn’t link these threads, so check it isn’t making the same point again.'}
		</div>
	)
}

const OUTCOME_TEXT: Record<RaisedOutcome, string> = {
	agreed: 'they agreed it should change',
	rejected: 'it was answered as not a problem',
	unanswered: 'it has no answer yet',
	unclear: 'it’s unclear what was decided',
}

/**
 * The AI's own account of a GitHub thread that raised the same problem: where it is, what was decided there, and why
 * it raises it again. `thread` is the thread as read now, when it is still there; the link saved with the run is the fallback.
 */
export function RaisedBeforeNote({ r, thread }: { r: RaisedBefore; thread: DiscussionThread | null }) {
	const url = thread?.url ?? r.url
	const where = thread?.placed?.startLine
		? `${r.path}:${thread.placed.startLine}`
		: thread?.originalLine
			? `${r.path}, was line ${thread.originalLine}`
			: r.path
	const by = thread?.comments[0]?.author
	return (
		<div className={`discussed-note raised-note small ${r.outcome}`}>
			<b>Raised before on GitHub:</b>{' '}
			{url ? (
				<a href={url} target="_blank" rel="noreferrer" title="Open the thread on GitHub">
					{by ? `${by}’s thread` : 'a thread'}
				</a>
			) : by ? (
				`${by}’s thread`
			) : (
				'a thread'
			)}{' '}
			on <span className="mono">{where}</span>
			{thread && thread.resolved !== null ? ` (${thread.resolved ? 'resolved' : 'open'})` : ''}. According to the AI,{' '}
			{OUTCOME_TEXT[r.outcome]}.
			{r.settled === false &&
				(r.outcome === 'agreed' || r.outcome === 'rejected') &&
				' Nobody with write access other than the PR author answered it, so it wasn’t treated as settled.'}
			<div>
				<b>Raised again because:</b> {r.whyAgain}
			</div>
		</div>
	)
}

/** Open / Resolved / Outdated, as short words for a card header. Unknown resolution (no token) shows nothing. */
export function ThreadState({ t }: { t: DiscussionThread }) {
	return (
		<>
			{t.resolved === true && (
				<span className="ic-state ok" title={t.resolvedBy ? `Resolved by ${t.resolvedBy}` : undefined}>
					Resolved
				</span>
			)}
			{t.resolved === false && <span className="ic-state gh">Open</span>}
			{t.outdated && (
				<span className="ic-state warn" title="The code it was written on has changed since. It may still be open.">
					Outdated
				</span>
			)}
		</>
	)
}

/** One GitHub comment inside an inline card: author, time, text. Third-party text: plain text only. */
export function InlineReply({ c }: { c: DiscussionComment }) {
	return (
		<div className="ic-reply">
			<div className="ic-head small">
				<b className="ic-who gh">{c.author ?? 'unknown user'}</b>
				{c.pending && <span className="ic-state">Pending · only you</span>}
				{c.createdAt && (
					<span className="muted" title={new Date(c.createdAt).toLocaleString()}>
						{ago(c.createdAt)}
					</span>
				)}
			</div>
			<div className="ic-body selectable">
				{c.body}
				{c.bodyTruncated && <span className="muted"> …(truncated)</span>}
			</div>
		</div>
	)
}

function StatusPills({ t }: { t: DiscussionThread }) {
	return (
		<>
			{t.resolved === true ? (
				<span className="gh-pill resolved" title={t.resolvedBy ? `Resolved by ${t.resolvedBy}` : undefined}>
					Resolved{t.resolvedBy ? ` by ${t.resolvedBy}` : ''}
				</span>
			) : t.resolved === false ? (
				<span className="gh-pill open">Open</span>
			) : (
				<span className="gh-pill" title="GitHub reports resolved state only to requests with a token">
					Resolution unknown
				</span>
			)}
			{t.outdated && (
				<span className="gh-pill outdated" title="GitHub marks it outdated: the code it was written on has changed. It may still be open.">
					Outdated
				</span>
			)}
		</>
	)
}

function CommentView({ c }: { c: DiscussionComment }) {
	return (
		<div className="gh-comment">
			<div className="gh-comment-head small">
				<b>{c.author ?? 'unknown user'}</b>
				{c.association && c.association !== 'NONE' && <span className="muted">{c.association.toLowerCase()}</span>}
				{c.pending && <span className="gh-pill">Pending · only you</span>}
				{c.createdAt && <span className="muted">{new Date(c.createdAt).toLocaleString()}</span>}
			</div>
			{/* Third-party text: plain text only. */}
			<div className="gh-comment-body selectable">
				{c.body}
				{c.bodyTruncated && <span className="muted"> …(truncated)</span>}
			</div>
		</div>
	)
}

function hunkTail(h: string): string {
	return h.split('\n').slice(-6).join('\n')
}

export type ReplyFn = (threadId: string, body: string, resolve: boolean) => Promise<string | null> // returns why it failed, or null

/** Reply to a GitHub thread and/or resolve it. Needs a token, which is also what tells us the thread's resolved state. */
export function ThreadReplyBox({ t, onReply }: { t: DiscussionThread; onReply: ReplyFn }) {
	const [open, setOpen] = useState(false)
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	if (t.resolved === null) return null
	const send = async (resolve: boolean): Promise<void> => {
		if (busy || (!text.trim() && !resolve)) return
		setBusy(true)
		setError(null)
		const problem = await onReply(t.id, text.trim(), resolve)
		setBusy(false)
		if (problem) return setError(problem)
		setText('')
		setOpen(false)
	}
	if (!open)
		return (
			<div className="ask-actions reply-actions">
				<button className="btn small ghost" onClick={() => setOpen(true)}>
					Reply
				</button>
				{t.resolved === false && (
					<button className="btn small ghost" onClick={() => void send(true)} disabled={busy}>
						{busy ? 'Resolving…' : 'Resolve'}
					</button>
				)}
				{error && <span className="small error-text">{error}</span>}
			</div>
		)
	return (
		<div className="ask-box reply-box">
			<textarea
				autoFocus
				value={text}
				rows={2}
				placeholder="Reply on GitHub (⌘↵ to send)"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault()
						void send(false)
					} else if (e.key === 'Escape') {
						e.preventDefault()
						setOpen(false)
					}
				}}
			/>
			{error && <p className="small error-text">{error}</p>}
			<div className="ask-actions">
				<span className="muted small">Posted to GitHub right away (or added to your pending review, if you have one).</span>
				<span className="spacer" />
				<button className="btn small ghost" onClick={() => setOpen(false)} disabled={busy}>
					Cancel
				</button>
				{t.resolved === false && (
					<button className="btn small" onClick={() => void send(true)} disabled={busy}>
						{text.trim() ? 'Reply and resolve' : 'Resolve'}
					</button>
				)}
				<button className="btn small primary" onClick={() => void send(false)} disabled={busy || !text.trim()}>
					{busy ? 'Sending…' : 'Reply'}
				</button>
			</div>
		</div>
	)
}

/** Replies a card leaves out, linked to GitHub. */
export function MoreOnGitHub({ t }: { t: DiscussionThread }) {
	if (!t.commentsOmitted) return null
	return <div className="muted small">{count(t.commentsOmitted, 'more reply', 'more replies')} on GitHub.</div>
}

/**
 * Someone else's thread on GitHub, read-only, in the code: who started it, its state, and the replies. Resolved threads
 * start as one line. Threads started by your own published comments are shown on your comment card instead.
 */
export function ThreadCard({ thread: t, onReply, mine }: { thread: DiscussionThread; onReply?: ReplyFn; mine?: MyLastReview | null }) {
	const from = firstNew(t.comments, mine)
	const [open, setOpen] = useState(t.resolved !== true || from >= 0)
	const [root, ...replies] = t.comments
	return (
		<div className={`ic ic-gh ${t.resolved ? 'is-resolved' : ''}`} data-item={t.id} onMouseUp={(e) => e.stopPropagation()}>
			<div className="ic-head">
				<button className="ic-toggle" onClick={() => setOpen((x) => !x)} aria-expanded={open} title={open ? 'Collapse' : 'Expand'}>
					{open ? '▾' : '▸'}
				</button>
				<b className="ic-who gh">{root?.author ?? 'unknown user'}</b>
				<ThreadState t={t} />
				{from === 0 && <span className="ic-state accent">New since your review</span>}
				{!open && root && <span className="ellipsis muted">{root.body.split('\n')[0]}</span>}
				{open && root?.createdAt && (
					<span className="muted small" title={new Date(root.createdAt).toLocaleString()}>
						{ago(root.createdAt)}
					</span>
				)}
				<span className="spacer" />
				{!open && replies.length + t.commentsOmitted > 0 && (
					<span className="muted small nowrap">{count(replies.length + t.commentsOmitted, 'reply', 'replies')}</span>
				)}
				{t.url && (
					<a className="btn small ghost" href={t.url} target="_blank" rel="noreferrer" title="Open on GitHub">
						↗
					</a>
				)}
			</div>
			{open && (
				<>
					{t.unplaced && (
						<div className="muted small">
							{t.unplaced}
							{t.originalLine !== null && ` Written on line ${t.originalLine}${t.side === 'old' ? ' of the old version' : ''}.`}
						</div>
					)}
					{t.unplaced && t.diffHunk && <pre className="outdated-code">{hunkTail(t.diffHunk)}</pre>}
					{root && (
						<div className="ic-body selectable">
							{root.body}
							{root.bodyTruncated && <span className="muted"> …(truncated)</span>}
						</div>
					)}
					{replies.map((c, i) => (
						<div key={c.id}>
							{i + 1 === from && <NewSinceDivider />}
							<InlineReply c={c} />
						</div>
					))}
					<MoreOnGitHub t={t} />
					{onReply && <ThreadReplyBox t={t} onReply={onReply} />}
				</>
			)}
		</div>
	)
}

function placeLabel(t: DiscussionThread): string {
	const p = t.placed
	if (!p) return t.originalLine !== null ? `was line ${t.originalLine}` : 'not shown at a line'
	if (p.startLine === null || p.endLine === null) return 'Whole file'
	return `${t.side === 'old' ? 'old ' : ''}${rangeLabel({ start: p.startLine, end: p.endLine })}`
}

/** "Since your review on 24 Oct (changes requested): 2 replied · 1 code changed · 3 no response", leaving out what is zero. */
function SinceLine({ mine, since, comments }: { mine: MyLastReview; since: Array<SinceMine>; comments: number }) {
	const n = (k: SinceMine): number => since.filter((x) => x === k).length
	const parts = [
		n('replied') && `${n('replied')} replied`,
		n('changed') && `${n('changed')} code changed`,
		n('waiting') && `${n('waiting')} no response`,
		n('new') && count(n('new'), 'new thread'),
		comments && count(comments, 'new review or comment', 'new reviews and comments'),
	].filter(Boolean)
	const when = new Date(mine.at).toLocaleDateString([], { day: 'numeric', month: 'short' })
	return (
		<div className="since-line small">
			<b>
				Since your{' '}
				{mine.url ? (
					<a href={mine.url} target="_blank" rel="noreferrer" title="Open your review on GitHub">
						review
					</a>
				) : (
					'review'
				)}{' '}
				on {when}
			</b>{' '}
			<span className="muted">
				({reviewState(mine.state)}
				{mine.commit ? ` on ${mine.commit.slice(0, 7)}` : ''}, {ago(mine.at)})
			</span>
			: {parts.length ? parts.join(' · ') : 'nothing new'}
		</div>
	)
}

interface PanelProps {
	discussion: Discussion | null
	loading: boolean
	files: Array<ChangedFile>
	onRefresh(): void
	onOpen(t: DiscussionThread): void
	onConnect(): void
}

/** Everything already said on the PR: threads by file (open first), review summaries and the conversation. */
export function DiscussionPanel({ discussion: d, loading, files, onRefresh, onOpen, onConnect }: PanelProps) {
	const order = new Map(files.map((f, i) => [f.key, i]))
	const rank = (t: DiscussionThread): number => (t.resolved === true ? 2 : t.resolved === null ? 1 : 0)
	const threads = [...(d?.threads ?? [])].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			(order.get(a.fileKey ?? '') ?? 1e9) - (order.get(b.fileKey ?? '') ?? 1e9) ||
			a.path.localeCompare(b.path) ||
			(a.placed?.startLine ?? a.originalLine ?? 0) - (b.placed?.startLine ?? b.originalLine ?? 0),
	)
	const openCount = threads.filter((t) => t.resolved === false).length
	const known = threads.some((t) => t.resolved !== null) // without a token GitHub doesn't say what's resolved
	const mine = d?.mine ?? null
	const since = new Map(
		threads.flatMap((t) => {
			const s = mine && sinceMine(t, mine)
			return s ? [[t.id, s] as const] : []
		}),
	)
	// Since your last review comes first when you have one, so a second round opens on what happened since.
	const [stored, setState] = useStored<ThreadFilter>('review.threadFilter', 'since', THREAD_FILTERS)
	const state = stored === 'since' ? (mine ? 'since' : 'all') : known ? stored : 'all'
	const [author, setAuthor] = useState<string | null>(null)
	const authors = [
		...new Set(
			[...threads.flatMap((t) => t.comments), ...(d?.reviews ?? []), ...(d?.conversation ?? [])].flatMap((x) =>
				x.author ? [x.author] : [],
			),
		),
	].sort((a, b) => a.localeCompare(b))
	const who = author && authors.includes(author) ? author : null
	const shown = threads.filter((t) => matchesThread(t, state, who, mine))
	if (state === 'since') shown.sort((a, b) => SINCE_ORDER[since.get(a.id)!] - SINCE_ORDER[since.get(b.id)!])
	// Reviews and the conversation have no open/resolved state, so they show under "All", and under "Since your review"
	// when someone else wrote them after it.
	const newer = <T extends { author: string | null; createdAt?: string | null; submittedAt?: string | null }>(xs: Array<T>): Array<T> =>
		mine ? xs.filter((x) => isNewSince(x, mine) && x.author !== mine.viewer) : []
	const newReviews = newer(d?.reviews ?? [])
	const newConversation = newer(d?.conversation ?? [])
	const showReviews = (state === 'all' ? (d?.reviews ?? []) : state === 'since' ? newReviews : []).filter((r) => !who || r.author === who)
	const showConversation = (state === 'all' ? (d?.conversation ?? []) : state === 'since' ? newConversation : []).filter(
		(c) => !who || c.author === who,
	)
	const narrowed = state !== 'all' || !!who
	return (
		<div className="comments">
			<div className="gh-status small">
				<span className="muted">
					{loading
						? 'Reading from GitHub…'
						: d
							? `Read ${new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · doesn’t update by itself`
							: ''}
				</span>
				<span className="spacer" />
				<button className="btn small" onClick={onRefresh} disabled={loading}>
					Refresh
				</button>
			</div>
			{d?.reason && (
				<div className={`gh-reason small ${d.status === 'unavailable' ? 'error-text' : 'warn-text'}`}>
					{d.reason}
					{d.threads.some((t) => t.resolved === null) && (
						<>
							{' '}
							<button className="link" onClick={onConnect}>
								Connect GitHub
							</button>
						</>
					)}
				</div>
			)}
			{mine && <SinceLine mine={mine} since={[...since.values()]} comments={newReviews.length + newConversation.length} />}
			{(threads.length > 0 || authors.length > 1 || mine) && (
				<div className="list-tools">
					{(known || mine) && (
						<div className="seg" role="tablist" aria-label="Thread state">
							{(
								[
									...(mine ? ([['since', 'Since your review', since.size]] as const) : []),
									['all', 'All', threads.length],
									...(known
										? ([
												['open', 'Open', openCount],
												['resolved', 'Resolved', threads.filter((t) => t.resolved === true).length],
											] as const)
										: []),
								] as const
							).map(([k, label, n]) => (
								<button key={k} role="tab" aria-selected={state === k} className={state === k ? 'on' : ''} onClick={() => setState(k)}>
									{label} <span className="count">{n}</span>
								</button>
							))}
						</div>
					)}
					{authors.length > 1 && (
						<select value={who ?? ''} onChange={(e) => setAuthor(e.target.value || null)} aria-label="Author">
							<option value="">Everyone</option>
							{authors.map((a) => (
								<option key={a} value={a}>
									{a}
								</option>
							))}
						</select>
					)}
				</div>
			)}
			<div className="comments-list">
				{d && d.status !== 'unavailable' && !threads.length && !d.reviews.length && !d.conversation.length && (
					<div className="muted pad small">No review comments or conversation on this pull request yet.</div>
				)}
				{narrowed && !shown.length && !showReviews.length && !showConversation.length && (
					<div className="muted pad small">
						{state === 'since' && !who ? 'Nothing new since your review.' : 'Nothing matches.'}{' '}
						<button
							className="link"
							onClick={() => {
								setState('all')
								setAuthor(null)
							}}
						>
							Clear filters
						</button>
					</div>
				)}
				{shown.length > 0 && (
					<section>
						<div className="section-title">
							Threads · {shown.length}
							{!narrowed && openCount ? ` · ${openCount} open` : ''}
						</div>
						{shown.map((t) => {
							const st = since.get(t.id)
							const from = firstNew(t.comments, mine)
							const fresh = from > 0 ? t.comments.slice(from).filter((c) => c.author !== mine?.viewer) : []
							const last = fresh[fresh.length - 1]
							return (
								<button key={t.id} className="comment-item" disabled={!t.fileKey} onClick={() => onOpen(t)}>
									<div className="ci-loc">
										<span className="mono ellipsis">{t.path}</span>
										<span className="muted small nowrap">{placeLabel(t)}</span>
									</div>
									<div className="gh-pills">
										{st && (
											<span className={`gh-pill since-${st}`} title={SINCE_TITLE[st]}>
												{SINCE_LABEL[st]}
											</span>
										)}
										<StatusPills t={t} />
										{!t.placed && t.fileKey && <span className="gh-pill">Listed with the file</span>}
									</div>
									<div className="ci-body">
										<b>{t.comments[0]?.author ?? 'unknown user'}:</b> {t.comments[0]?.body}
									</div>
									{last && (
										<div className="ci-body ci-new">
											<b>{last.author ?? 'unknown user'}:</b> {last.body}
										</div>
									)}
									{t.comments.length + t.commentsOmitted > 1 && (
										<div className="muted small">
											{count(t.comments.length - 1 + t.commentsOmitted, 'reply', 'replies')}
											{fresh.length ? `, ${fresh.length} new` : ''}
										</div>
									)}
								</button>
							)
						})}
					</section>
				)}
				{showReviews.length > 0 && (
					<section>
						<div className="section-title">Reviews · {showReviews.length}</div>
						{showReviews.map((r) => (
							<div key={r.id} className="gh-thread">
								<div className="gh-comment-head small">
									<b>{r.author ?? 'unknown user'}</b>
									<span className={`gh-pill ${r.state === 'APPROVED' ? 'resolved' : r.state === 'CHANGES_REQUESTED' ? 'open' : ''}`}>
										{r.state.toLowerCase().replace(/_/g, ' ')}
									</span>
									{r.submittedAt && <span className="muted">{new Date(r.submittedAt).toLocaleString()}</span>}
									<span className="spacer" />
									{r.url && (
										<a className="btn small ghost" href={r.url} target="_blank" rel="noreferrer">
											↗
										</a>
									)}
								</div>
								{r.body && <div className="gh-comment-body selectable">{r.body}</div>}
							</div>
						))}
					</section>
				)}
				{showConversation.length > 0 && (
					<section>
						<div className="section-title">Conversation · {showConversation.length}</div>
						{showConversation.map((c) => (
							<div key={c.id} className="gh-thread">
								<CommentView c={c} />
							</div>
						))}
					</section>
				)}
			</div>
		</div>
	)
}
