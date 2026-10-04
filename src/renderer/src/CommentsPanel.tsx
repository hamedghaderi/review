import { useState } from 'react'
import { LEVEL_META } from '../../shared/findings.ts'
import type { Anchor, ChangedFile, CommentDraft, ReviewComment, Severity } from '../../shared/types.ts'
import { anchorPath } from './Comment.tsx'
import { rangeLabel } from './diffModel.ts'
import { RichText } from './RichText.tsx'

interface Props {
	comments: Array<ReviewComment>
	drafts: Array<CommentDraft>
	files: Array<ChangedFile>
	onOpen(fileKey: string, itemId: string, anchor: ReviewComment['anchor'], draftId: string | null): void
}

export function CommentsPanel({ comments, drafts, files, onOpen }: Props) {
	const order = new Map(files.map((f, i) => [f.key, i]))
	const sortKey = (a: ReviewComment['anchor']): [number, number] => [order.get(a.fileKey) ?? 1e9, a.startLine ?? 0]
	const byPos = <T extends { anchor: ReviewComment['anchor'] }>(xs: Array<T>): Array<T> =>
		[...xs].sort((x, y) => {
			const [a1, a2] = sortKey(x.anchor)
			const [b1, b2] = sortKey(y.anchor)
			return a1 - b1 || a2 - b2
		})
	const unfinished = byPos(drafts.filter((d) => d.body.trim()))
	const sorted = byPos(comments)
	const current = sorted.filter((c) => !c.carried?.outdated)
	const outdated = sorted.filter((c) => c.carried?.outdated)
	const [showOutdated, setShowOutdated] = useState(true)

	const item = (c: ReviewComment) => {
		const gone = !order.has(c.anchor.fileKey)
		return (
			<button
				key={c.id}
				className={`comment-item ${c.carried?.outdated ? 'outdated' : ''}`}
				disabled={gone}
				title={gone ? 'This file is no longer part of the changes' : undefined}
				onClick={() => onOpen(c.anchor.fileKey, c.id, c.anchor, null)}
			>
				<Card comment={c} anchor={c.anchor} body={c.body} fromAi={!!c.findingId} />
			</button>
		)
	}

	return (
		<div className="comments">
			<div className="comments-list">
				{unfinished.length > 0 && (
					<section>
						<div className="section-title">Unfinished · {unfinished.length}</div>
						{unfinished.map((d) => (
							<button key={d.id} className="comment-item draft" onClick={() => onOpen(d.anchor.fileKey, d.id, d.anchor, d.id)}>
								<Card
									anchor={d.anchor}
									body={d.body}
									fromAi={!!d.findingId}
									note={d.commentId ? 'Editing' : d.findingId ? 'Not added yet' : undefined}
								/>
							</button>
						))}
					</section>
				)}
				{comments.length === 0 && unfinished.length === 0 ? (
					<div className="muted pad small">
						No comments yet. Click a line number, Shift-click to extend, or select code text to start a comment.
					</div>
				) : (
					<>
						{current.length > 0 && (
							<section>
								{(unfinished.length > 0 || outdated.length > 0) && <div className="section-title">Current · {current.length}</div>}
								{current.map(item)}
							</section>
						)}
						{outdated.length > 0 && (
							<section className="outdated-group">
								<button
									className="section-title section-toggle"
									aria-expanded={showOutdated}
									onClick={() => setShowOutdated((v) => !v)}
									title="The code these were written on has changed. They are still published, as comments on the file."
								>
									<span className={`chev ${showOutdated ? 'open' : ''}`} aria-hidden>
										▸
									</span>
									Outdated · {outdated.length}
								</button>
								{showOutdated && outdated.map(item)}
							</section>
						)}
					</>
				)}
			</div>
		</div>
	)
}

// The label line the app writes at the top of a comment made from a finding: `🟠 <kbd>SHOULD FIX</kbd> <kbd>error handling</kbd>`.
const LEVEL_LINE = /^\s*\S+\s+<kbd>([^<\n]+)<\/kbd>(?:\s+<kbd>([^<\n]+)<\/kbd>)?[^\S\n]*(?:\n\s*|$)/
const LEVEL_BY_LABEL = new Map(Object.entries(LEVEL_META).map(([k, m]) => [m.label.toUpperCase(), k as Severity]))

/** Splits a leading level line off the body, so the card can show it as a badge instead of raw chips. */
function splitLevel(body: string): { level: Severity | null; topic: string | null; rest: string } {
	const m = LEVEL_LINE.exec(body)
	const level = m ? (LEVEL_BY_LABEL.get(m[1].trim().toUpperCase()) ?? null) : null
	if (!m || !level) return { level: null, topic: null, rest: body.trim() }
	return { level, topic: m[2]?.trim() ?? null, rest: body.slice(m[0].length).trim() }
}

function Card(props: { comment?: ReviewComment; anchor: Anchor; body: string; fromAi: boolean; note?: string }) {
	const { comment: c, body, fromAi, note } = props
	const outdated = c?.carried?.outdated ? c.carried : null
	// An outdated comment shows the lines it was written on, from the snapshot it came from.
	const a = outdated ? outdated.anchor : props.anchor
	const path = anchorPath(a)
	const slash = path.lastIndexOf('/')
	const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
	const name = path.slice(slash + 1)
	const range = a.side === null || a.startLine === null || a.endLine === null ? 'File' : rangeLabel({ start: a.startLine, end: a.endLine })
	const code = outdated ? outdated.outdated!.code : a.excerpt ? a.excerpt.replace(/\n+$/, '').split('\n') : []
	const { level, topic, rest } = splitLevel(body)

	return (
		<>
			<div className="ci-loc" title={path}>
				<span className="ci-file">
					{dir && (
						<span className="ci-dir">
							{/* rtl cuts the start of the path; bdi keeps the path itself left to right */}
							<bdi>{dir}</bdi>
						</span>
					)}
					<span className="ci-name">{name}</span>
				</span>
				<span className="ci-range">
					{outdated && (
						<span
							className="ci-outdated"
							title={`${outdated.outdated!.reason} Written on ${a.headSha.slice(0, 7)}${a.side === 'old' ? ' (old version)' : ''}.`}
						>
							outdated ·{' '}
						</span>
					)}
					{a.side === 'old' ? 'old ' : ''}
					{range}
				</span>
			</div>
			{(level || fromAi || note) && (
				<div className="ci-tags">
					{level && (
						<span className={`sev ${level}`} title={LEVEL_META[level].hint}>
							{LEVEL_META[level].label}
						</span>
					)}
					{topic && <span className="ci-topic">{topic}</span>}
					{note && <span className="ci-pill">{note}</span>}
					<span className="spacer" />
					{fromAi && (
						<span className="ci-pill ai" title="Made from an AI finding">
							AI
						</span>
					)}
				</div>
			)}
			{code.length > 0 && (
				<pre className={`ci-excerpt ${outdated ? 'outdated' : ''}`}>
					{code.slice(0, 3).map((l, i) => (
						<div key={i}>
							{a.startLine !== null && <span className="oln">{a.startLine + i}</span>}
							{l}
						</div>
					))}
					{code.length > 3 && <div className="ci-more">+{code.length - 3} more lines</div>}
				</pre>
			)}
			{rest && <RichText className="ci-body" text={rest} flat />}
		</>
	)
}
