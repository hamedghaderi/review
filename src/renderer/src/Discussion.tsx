import { useState } from 'react'
import type { ChangedFile, Discussion, DiscussionComment, DiscussionThread } from '../../shared/types.ts'
import { rangeLabel } from './diffModel.ts'

function who(ts: Array<DiscussionThread>): string {
	const names = [...new Set(ts.map((t) => t.comments[0]?.author ?? 'unknown user'))]
	return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`
}

/** "Already discussed on GitHub: 1 open thread (alice) · 1 resolved (bob)." */
export function AlreadyDiscussed({ threads }: { threads: Array<DiscussionThread> }) {
	if (!threads.length) return null
	const open = threads.filter((t) => t.resolved === false)
	const resolved = threads.filter((t) => t.resolved === true)
	const unknown = threads.filter((t) => t.resolved === null)
	const parts = [
		open.length ? `${count(open.length, 'open thread')} (${who(open)})` : null,
		resolved.length ? `${resolved.length} resolved (${who(resolved)})` : null,
		unknown.length ? `${count(unknown.length, 'thread')} (${who(unknown)})` : null,
	].filter(Boolean)
	return (
		<div
			className="discussed-note small"
			title="Shown so you can read the thread first. It doesn't change or hide anything, and a resolved thread doesn't mean the code changed."
		>
			<b>Already discussed on GitHub:</b> {parts.join(' · ')}.
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

/** A GitHub thread, read-only. Resolved threads start collapsed; open ones stay open even when outdated. */
export function ThreadCard({ thread: t }: { thread: DiscussionThread }) {
	const [open, setOpen] = useState(t.resolved !== true)
	const root = t.comments[0]
	const replies = t.comments.length - 1 + t.commentsOmitted
	return (
		<div className={`gh-thread ${t.resolved ? 'is-resolved' : ''}`} data-item={t.id} onMouseUp={(e) => e.stopPropagation()}>
			<div className="gh-thread-head">
				<span className="gh-badge">On GitHub</span>
				<StatusPills t={t} />
				<button className="link small ellipsis" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
					{open ? '▾' : '▸'} {root?.author ?? 'unknown user'}
					{!open && root ? `: ${root.body.split('\n')[0]}` : ''}
					{replies > 0 ? ` · ${count(replies, 'reply', 'replies')}` : ''}
				</button>
				<span className="spacer" />
				{t.url && (
					<a className="btn small ghost" href={t.url} target="_blank" rel="noreferrer">
						GitHub ↗
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
					{t.comments.map((c) => (
						<CommentView key={c.id} c={c} />
					))}
					{t.commentsOmitted > 0 && <div className="muted small">{count(t.commentsOmitted, 'more comment')} on GitHub.</div>}
				</>
			)}
		</div>
	)
}

function placeLabel(t: DiscussionThread): string {
	const p = t.placed
	if (!p) return t.originalLine !== null ? `was line ${t.originalLine}` : 'not shown at a line'
	if (p.startLine === null || p.endLine === null) return 'File'
	return `${t.side === 'old' ? 'Old' : 'New'} · ${rangeLabel({ start: p.startLine, end: p.endLine })}`
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
			<div className="comments-list">
				{d && d.status !== 'unavailable' && !threads.length && !d.reviews.length && !d.conversation.length && (
					<div className="muted pad small">No review comments or conversation on this pull request yet.</div>
				)}
				{threads.length > 0 && (
					<section>
						<div className="section-title">
							Threads · {threads.length}
							{openCount ? ` · ${openCount} open` : ''}
						</div>
						{threads.map((t) => (
							<button key={t.id} className="comment-item" disabled={!t.fileKey} onClick={() => onOpen(t)}>
								<div className="ci-loc">
									<span className="mono ellipsis">{t.path}</span>
									<span className="muted small nowrap">{placeLabel(t)}</span>
								</div>
								<div className="gh-pills">
									<StatusPills t={t} />
									{!t.placed && t.fileKey && <span className="gh-pill">Listed with the file</span>}
								</div>
								<div className="ci-body">
									<b>{t.comments[0]?.author ?? 'unknown user'}:</b> {t.comments[0]?.body}
								</div>
								{t.comments.length + t.commentsOmitted > 1 && (
									<div className="muted small">{count(t.comments.length - 1 + t.commentsOmitted, 'reply', 'replies')}</div>
								)}
							</button>
						))}
					</section>
				)}
				{d && d.reviews.length > 0 && (
					<section>
						<div className="section-title">Reviews · {d.reviews.length}</div>
						{d.reviews.map((r) => (
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
				{d && d.conversation.length > 0 && (
					<section>
						<div className="section-title">Conversation · {d.conversation.length}</div>
						{d.conversation.map((c) => (
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
