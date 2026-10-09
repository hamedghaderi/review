import { useEffect, useRef } from 'react'
import type { Anchor, CommentDraft, DiscussionThread, ReviewComment } from '../../shared/types.ts'
import { AlreadyDiscussed, InlineReply, MoreOnGitHub, ThreadState } from './Discussion.tsx'
import { useGifCommand } from './GifPicker.tsx'
import { rangeLabel } from './diffModel.ts'
import { RichText } from './RichText.tsx'

export function anchorLabel(a: Anchor): string {
	if (a.side === null || a.startLine === null || a.endLine === null) return 'File comment'
	return `${a.side === 'old' ? 'Old' : 'New'} · ${rangeLabel({ start: a.startLine, end: a.endLine })}`
}

/** The code an outdated comment was written on, with its old line numbers. */
export function OutdatedCode({ comment: c }: { comment: ReviewComment }) {
	const from = c.carried
	if (!from?.outdated) return null
	const a = from.anchor
	return (
		<div className="outdated">
			<div className="muted small">
				{from.outdated.reason} Written on {a.headSha.slice(0, 7)}
				{a.side === 'old' ? ' (old version)' : ''}.
			</div>
			{from.outdated.code.length > 0 && (
				<pre className="outdated-code">
					{from.outdated.code.map((l, i) => (
						<div key={i}>
							<span className="oln">{(a.startLine ?? 0) + i}</span>
							{l}
						</div>
					))}
				</pre>
			)}
		</div>
	)
}

export function anchorPath(a: Anchor): string {
	if (a.side === 'old' && a.oldPath) return a.oldPath
	return (a.newPath ?? a.oldPath) as string
}

interface ComposerProps {
	draft: CommentDraft
	discussed: Array<DiscussionThread>
	extending: boolean
	onChange(body: string): void
	onSubmit(): void
	onKeep(): void
	onDiscard(): void
	onToggleExtend?(): void
	onAskAi?(): void // drafts made from an AI finding: ask the model about it
}

export function Composer({ draft, discussed, extending, onChange, onSubmit, onKeep, onDiscard, onToggleExtend, onAskAi }: ComposerProps) {
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => {
		ref.current?.focus({ preventScroll: true })
	}, [draft.id])
	const gif = useGifCommand(draft.body, ref, (next) => onChange(next))
	const a = draft.anchor
	const editing = draft.commentId !== null
	return (
		<div className="composer" data-item={draft.id} onMouseUp={(e) => e.stopPropagation()}>
			<div className="composer-head">
				<b className="ic-who you">You</b>
				<span className="muted small" title={anchorPath(a)}>
					{editing ? 'Editing' : 'Commenting on'} {a.side ? rangeLabel({ start: a.startLine!, end: a.endLine! }) : 'the whole file'}
					{a.side === 'old' ? ' of the old version' : ''}
				</span>
				<span className="spacer" />
				{onToggleExtend && a.side && (
					<button
						className={`btn small ghost ${extending ? 'on' : ''}`}
						onClick={onToggleExtend}
						aria-pressed={extending}
						title="Then click another line number on the same side"
					>
						{extending ? 'Click a line number…' : 'Extend range'}
					</button>
				)}
			</div>
			<AlreadyDiscussed threads={discussed} />
			<div className="gif-anchor">
				<textarea
					ref={ref}
					value={draft.body}
					placeholder={editing ? 'Edit comment (type /gif and a word for a GIF)' : 'Leave a comment (type /gif and a word for a GIF)'}
					rows={3}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (gif.onKeyDown(e)) return
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault()
							onSubmit()
						} else if (e.key === 'Escape') {
							e.preventDefault()
							onKeep()
						}
					}}
				/>
				{gif.panel}
			</div>
			<div className="composer-actions">
				<span className="muted small">⌘↵ to {editing ? 'update' : 'add'} · Esc to close</span>
				<span className="spacer" />
				{onAskAi && <AskAiButton onClick={onAskAi} />}
				<button className="btn small ghost" onClick={onDiscard}>
					{editing ? 'Discard edit' : 'Discard'}
				</button>
				<button className="btn small" onClick={onKeep} title="Close and keep the text as an unfinished draft">
					Keep draft
				</button>
				<button className="btn small primary" onClick={onSubmit} disabled={!draft.body.trim()}>
					{editing ? 'Update comment' : 'Add comment'}
				</button>
			</div>
		</div>
	)
}

/** A comment's state on GitHub, in a PR review. */
export interface PostedState {
	url: string | null // its published copy; null: not posted yet
	edited: boolean // changed here since it was posted
	thread: DiscussionThread | null // the thread it started, once the discussion is read
}

interface CardProps {
	comment: ReviewComment
	posted: PostedState | null // null outside PR reviews, where nothing is posted
	pendingEdit: boolean
	discussed: Array<DiscussionThread>
	onEdit(): void
	onDelete(): void
	onAskAi?(): void // comments made from an AI finding: ask the model about it
}

/** Where your comment stands: only here, on GitHub, or on GitHub with a newer edit not sent yet. */
function SentState({ posted }: { posted: PostedState }) {
	if (!posted.url) return <span className="ic-state">Not posted</span>
	return (
		<>
			<a className="ic-state gh" href={posted.url} target="_blank" rel="noreferrer" title="Open on GitHub">
				On GitHub ↗
			</a>
			{posted.edited && (
				<span className="ic-state accent" title="Publish to update the copy on GitHub">
					Edit not posted
				</span>
			)}
		</>
	)
}

function AskAiButton({ onClick }: { onClick(): void }) {
	return (
		<button className="btn small ghost" onClick={onClick} title="Ask the model that raised this finding a question about it">
			Ask AI
		</button>
	)
}

export function CommentCard({ comment, posted, pendingEdit, discussed, onEdit, onDelete, onAskAi }: CardProps) {
	const thread = posted?.thread ?? null
	const replies = thread ? thread.comments.slice(1) : []
	return (
		<div className="ic ic-you" data-item={comment.id} onMouseUp={(e) => e.stopPropagation()}>
			<div className="ic-head">
				<b className="ic-who you">You</b>
				{posted && <SentState posted={posted} />}
				{thread && <ThreadState t={thread} />}
				{comment.carried?.outdated && !thread?.outdated && (
					<span className="ic-state warn" title={comment.carried.outdated.reason}>
						Outdated
					</span>
				)}
				{pendingEdit && <span className="ic-state accent">Unsaved edit</span>}
				{comment.findingId && <span className="muted small">from AI</span>}
				<span className="spacer" />
				{onAskAi && <AskAiButton onClick={onAskAi} />}
				<button className="btn small ghost" onClick={onEdit}>
					{pendingEdit ? 'Resume edit' : 'Edit'}
				</button>
				<button className="btn small ghost danger" onClick={onDelete}>
					Delete
				</button>
			</div>
			<OutdatedCode comment={comment} />
			<AlreadyDiscussed threads={discussed} />
			<RichText className="ic-body" text={comment.body} />
			{replies.map((c) => (
				<InlineReply key={c.id} c={c} />
			))}
			{thread && <MoreOnGitHub t={thread} />}
		</div>
	)
}

export function DraftStub({ draft, onResume, onDiscard }: { draft: CommentDraft; onResume(): void; onDiscard(): void }) {
	return (
		<div className="ic ic-you ic-draft" data-item={draft.id} onMouseUp={(e) => e.stopPropagation()}>
			<div className="ic-head">
				<b className="ic-who you">You</b>
				<span className="ic-state accent">Draft</span>
				<span className="ellipsis muted">{draft.body.split('\n')[0] || 'Empty'}</span>
				<span className="spacer" />
				<button className="btn small ghost" onClick={onDiscard}>
					Discard
				</button>
				<button className="btn small" onClick={onResume}>
					Resume
				</button>
			</div>
		</div>
	)
}
